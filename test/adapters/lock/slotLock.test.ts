import { afterEach, expect, test } from 'vitest';
import {
  mkdir,
  mkdtemp,
  symlink,
  rename,
  writeFile,
  rm,
  open,
  readFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  acquireSlot,
  SlotBusyError,
  UnsupportedLockError,
} from '../../../src/adapters/lock/slotLock.js';

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
    await expect(lock.readMetadata()).rejects.toThrow('inode replaced');
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

test('atomic metadata replacement preserves already-open snapshots and replaces the inode', async () => {
  const root = await directory();
  const lock = await acquireSlot(root, 1);
  const before = { version: 1, state: 'unbound', incomplete: true } as const;
  try {
    await lock.writeMetadata(before);
    const snapshot = await open(lock.metadataPath, 'r');
    try {
      const oldStat = await snapshot.stat();
      await lock.writeMetadata({ ...before, incomplete: false });
      expect(JSON.parse(await snapshot.readFile('utf8'))).toEqual(before);
      expect((await stat(lock.metadataPath)).ino).not.toBe(oldStat.ino);
      expect((await lock.readMetadata())?.incomplete).toBe(false);
    } finally {
      await snapshot.close();
    }
  } finally {
    await lock.close();
  }
});

test.each([
  '',
  '{',
  'null',
  '[]',
  '42',
  '{"version":2,"state":"unbound","incomplete":false}',
  '{"version":1,"state":"unbound"}',
  '{"version":1,"state":"other","incomplete":false}',
  '{"version":1,"state":"unbound","incomplete":false,"checkoutPath":"/tmp"}',
  '{"version":1,"state":"bound","incomplete":false,"checkoutGitDir":"/tmp"}',
])('malformed metadata refuses read and reuse: %s', async (text) => {
  const root = await directory();
  const lock = await acquireSlot(root, 1);
  try {
    await writeFile(lock.metadataPath, text);
    await expect(lock.readMetadata()).rejects.toThrow();
    await expect(lock.assertReusable()).rejects.toThrow();
  } finally {
    await lock.close();
  }
});

test('symlinked lock is refused with a declared error and leaves target intact', async () => {
  const root = await directory();
  await mkdir(join(root, 'cq-review', 'slots'), { recursive: true });
  const target = join(root, 'target');
  await writeFile(target, 'untouched');
  await symlink(target, join(root, 'cq-review', 'slots', 'pr-1.lock'));
  await expect(acquireSlot(root, 1)).rejects.toMatchObject({ name: 'UnsupportedLockError' });
  await expect(acquireSlot(root, 1)).rejects.toBeInstanceOf(UnsupportedLockError);
  expect(await readFile(target, 'utf8')).toBe('untouched');
});

test('metadata symlinks and non-regular files refuse read and reuse', async () => {
  const root = await directory();
  const lock = await acquireSlot(root, 1);
  const target = join(root, 'target');
  try {
    await writeFile(target, '{"version":1,"state":"unbound","incomplete":false}');
    await symlink(target, lock.metadataPath);
    await expect(lock.readMetadata()).rejects.toThrow();
    await expect(lock.assertReusable()).rejects.toThrow();
    await rm(lock.metadataPath);
    await mkdir(lock.metadataPath);
    await expect(lock.readMetadata()).rejects.toThrow('regular file');
    await rm(lock.metadataPath, { recursive: true });
    const fifo = spawn('mkfifo', [lock.metadataPath], { stdio: 'ignore' });
    children.push(fifo);
    const code: unknown = (await once(fifo, 'exit'))[0];
    expect(code).toBe(0);
    await expect(lock.readMetadata()).rejects.toThrow('regular file');
  } finally {
    await lock.close();
  }
});

test('FileHandles remain pinned through exposed GC with retained and dropped slot objects', async () => {
  const root = await directory();
  const url = new URL('../../../src/adapters/lock/slotLock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import { acquireSlot, SlotBusyError } from ${JSON.stringify(url)};
    const common = process.argv[1];
    let slot = await acquireSlot(common, 1);
    const fd = slot.fd;
    const contend = async () => {
      try { const other = await acquireSlot(common, 1); await other.close(); throw Error('GC unlocked'); }
      catch (error) { if (!(error instanceof SlotBusyError)) throw error; }
    };
    for (let n = 0; n < 30; n++) { global.gc(); await new Promise(r => setImmediate(r)); }
    await contend();
    await slot.assertIdentity();
    slot = undefined;
    for (let n = 0; n < 30; n++) { global.gc(); await new Promise(r => setImmediate(r)); }
    await contend();
    if (!Number.isInteger(fd)) throw Error('invalid borrowed descriptor');
    console.log('GC exclusion held');
  `,
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  child.stdout?.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr?.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const code: unknown = (await once(child, 'exit'))[0];
  expect(output).not.toContain('DEP0137');
  expect(output).toContain('GC exclusion held');
  expect(code).toBe(0);
  const successor = await acquireSlot(root, 1);
  await successor.close();
});

test('unsupported platform refuses before creating namespace', async () => {
  const root = await directory();
  const url = new URL('../../../src/adapters/lock/slotLock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { acquireSlot, UnsupportedLockError } from ${JSON.stringify(url)};
    Object.defineProperty(process, 'platform', {value: 'win32'});
    try { await acquireSlot(process.argv[1], 1); process.exitCode = 1; }
    catch (error) { if (!(error instanceof UnsupportedLockError)) throw error; }
  `,
      root,
    ],
    { stdio: 'ignore' },
  );
  children.push(child);
  const code: unknown = (await once(child, 'exit'))[0];
  expect(code).toBe(0);
  await expect(stat(join(root, 'cq-review'))).rejects.toMatchObject({ code: 'ENOENT' });
});
