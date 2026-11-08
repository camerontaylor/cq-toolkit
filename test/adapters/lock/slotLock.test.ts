import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, symlink, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { acquireSlot, SlotBusyError } from '../../../src/adapters/lock/slotLock.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'cq-slot-'));
  directories.push(path);
  return path;
}
async function holder(common: string, orphan = false, incomplete = false) {
  const url = new URL('../../../src/adapters/lock/slotLock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { acquireSlot } from ${JSON.stringify(url)};
    import { spawn } from 'node:child_process';
    const lock = await acquireSlot(process.argv[1], 1);
    ${
      orphan
        ? `const writer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      {stdio:['ignore','ignore','ignore',lock.fd]});
      console.log(writer.pid);`
        : ''
    }
    ${incomplete ? `await lock.writeMetadata({version:1, state:'unbound', incomplete:true});` : ''}
    console.log('ready'); setInterval(()=>{},1000);
  `,
      common,
    ],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Holder timeout: ${output}`)), 5000);
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.includes('ready')) {
        clearTimeout(timer);
        accept();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Holder exited ${code}`));
    });
    child.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });
  });
  return { child, output };
}

test('real holder excludes contenders through SIGSTOP and releases after SIGKILL', async () => {
  const common = await directory();
  const { child } = await holder(common);
  await expect(acquireSlot(common, 1)).rejects.toBeInstanceOf(SlotBusyError);
  child.kill('SIGSTOP');
  await expect(acquireSlot(common, 1)).rejects.toBeInstanceOf(SlotBusyError);
  const other = await acquireSlot(common, 2);
  await other.close();
  child.kill('SIGKILL');
  await once(child, 'exit');
  const next = await acquireSlot(common, 1);
  await next.close();
});

test('inherited descriptor excludes after parent death until orphan closes', async () => {
  const common = await directory();
  const { child, output } = await holder(common, true);
  const pid = Number(output.split('\n')[0]);
  try {
    child.kill('SIGKILL');
    await once(child, 'exit');
    await expect(acquireSlot(common, 1)).rejects.toBeInstanceOf(SlotBusyError);
  } finally {
    process.kill(pid, 'SIGKILL');
  }
  // Bounded retry waits for kernel process exit, never a blocking flock.
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      next = await acquireSlot(common, 1);
      break;
    } catch (error) {
      if (!(error instanceof SlotBusyError)) throw error;
    }
    await new Promise((accept) => setTimeout(accept, 10));
  }
  expect(next).toBeDefined();
  await next?.close();
});

test('canonical aliases and checkout Git-dir keys share exclusion', async () => {
  const root = await directory();
  const alias = `${root}-alias`;
  directories.push(alias);
  await symlink(root, alias);
  for (const key of [1, { checkoutGitDir: root }]) {
    const lock = await acquireSlot(root, key);
    try {
      const aliasKey = typeof key === 'number' ? key : { checkoutGitDir: alias };
      await expect(acquireSlot(alias, aliasKey)).rejects.toBeInstanceOf(SlotBusyError);
    } finally {
      await lock.close();
    }
  }
});

test('replacement is detected and metadata cannot be written under replaced inode', async () => {
  const root = await directory();
  const lock = await acquireSlot(root, 1);
  try {
    await rename(lock.path, `${lock.path}.old`);
    await writeFile(lock.path, '');
    await expect(lock.assertIdentity()).rejects.toThrow('inode replaced');
    await expect(
      lock.writeMetadata({
        version: 1,
        state: 'bound',
        checkoutPath: root,
        checkoutGitDir: root,
        incomplete: true,
      }),
    ).rejects.toThrow('inode replaced');
  } finally {
    await lock.close();
  }
});

test('per-slot metadata persists incomplete state across close and drains independently', async () => {
  const root = await directory();
  const first = await acquireSlot(root, 1);
  expect(await first.readMetadata()).toBeUndefined();
  await first.writeMetadata({
    version: 1,
    state: 'bound',
    checkoutPath: root,
    checkoutGitDir: root,
    incomplete: true,
  });
  await first.close();
  const next = await acquireSlot(root, 1);
  const other = await acquireSlot(root, 2);
  try {
    const state = await next.readMetadata();
    expect(state?.incomplete).toBe(true);
    expect(await other.readMetadata()).toBeUndefined();
    await next.writeMetadata({ ...state!, incomplete: false });
    expect((await next.readMetadata())?.incomplete).toBe(false);
  } finally {
    await next.close();
    await other.close();
  }
});

test('unbound incomplete metadata survives SIGKILL and refuses reuse until reconciled', async () => {
  const common = await directory();
  const { child } = await holder(common, false, true);
  child.kill('SIGKILL');
  await once(child, 'exit');
  const successor = await acquireSlot(common, 1);
  try {
    expect(await successor.readMetadata()).toEqual({
      version: 1,
      state: 'unbound',
      incomplete: true,
    });
    await expect(successor.assertReusable()).rejects.toThrow('requires reconciliation');
    await successor.writeMetadata({ version: 1, state: 'unbound', incomplete: false });
    await successor.assertReusable();
  } finally {
    await successor.close();
  }
});

test('slot transitions unbound to bound to unbound across checkout creation and removal', async () => {
  const common = await directory();
  const checkout = join(common, 'new-checkout');
  const lock = await acquireSlot(common, 1);
  try {
    await lock.writeMetadata({ version: 1, state: 'unbound', incomplete: true });
    expect(await lock.readMetadata()).toEqual({ version: 1, state: 'unbound', incomplete: true });
    await mkdir(checkout);
    await lock.writeMetadata({
      version: 1,
      state: 'bound',
      incomplete: true,
      checkoutPath: checkout,
      checkoutGitDir: checkout,
    });
    expect((await lock.readMetadata())?.state).toBe('bound');
    await rm(checkout, { recursive: true });
    await lock.writeMetadata({ version: 1, state: 'unbound', incomplete: false });
    expect(await lock.readMetadata()).toEqual({ version: 1, state: 'unbound', incomplete: false });
  } finally {
    await lock.close();
  }
});
