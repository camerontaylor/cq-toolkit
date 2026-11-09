import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  CheckoutWriterContext,
  checkoutWriterStdio,
} from '../../src/shared/checkoutWriterContext.js';
import { acquireSlot } from '../../src/adapters/lock/slotLock.js';
import { checkoutWriterCommand } from '../../src/shared/checkoutWriterCommand.js';
import { makeGhRunner } from '../../src/adapters/forge-github/gh.js';
import { spawnManaged } from '../../src/shared/proc.js';
import { spawnAcpProcess } from '../../src/driver/acp/process.js';
import { runArgvCommand, runShellCommand } from '../../src/harness/run.js';
import { makeSubprocessDevEffects } from '../../src/ops/dev/effects.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cq-writer-'));
  roots.push(root);
  const context = new CheckoutWriterContext(acquireSlot);
  const first = await context.acquire(root, 1),
    second = await context.acquire(root, 2);
  await context.begin();
  const expected = await Promise.all(
    [first.path, second.path].map(async (path) => {
      const s = await stat(path);
      return [s.dev, s.ino];
    }),
  );
  const script = join(root, 'probe.cjs');
  await writeFile(
    script,
    `const fs = require('node:fs'); console.log(JSON.stringify([3,4].map(fd => {try {const s=fs.fstatSync(fd); return [s.dev,s.ino]} catch {return null}})));`,
  );
  return { root, context, expected, script };
}

// These are adapter contract oracles. D's switch PR adds shipped-entrypoint crash oracles.
test.each(['gh', 'managed', 'acp', 'argv', 'shell', 'effects', 'collector'] as const)(
  '%s passes every held inode to child fd 3 onward (mutation: omit this boundary descriptor append)',
  async (boundary) => {
    const f = await fixture();
    try {
      const stdout = await f.context.run(async () => {
        const args = [f.script];
        if (boundary === 'gh') return (await makeGhRunner({ bin: process.execPath })(args)).stdout;
        if (boundary === 'managed')
          return (await spawnManaged({ command: process.execPath, args, cwd: f.root }).close)
            .stdout;
        if (boundary === 'acp') {
          const child = spawnAcpProcess({ command: process.execPath, args, cwd: f.root, env: {} });
          let out = '';
          child.stdout!.on('data', (chunk: string) => {
            out += chunk;
          });
          await once(child, 'close');
          return out;
        }
        if (boundary === 'effects')
          return (
            await makeSubprocessDevEffects(f.root).runCommand(process.execPath, args, {
              timeoutMs: 5000,
            })
          ).stdout;
        if (boundary === 'collector')
          return (await checkoutWriterCommand(process.execPath, args)).stdout;
        const opts = { cwd: f.root, env: {}, maxBytes: 4096, timeoutMs: 5000 };
        const result =
          boundary === 'argv'
            ? await runArgvCommand(process.execPath, args, opts)
            : await runShellCommand(`'${process.execPath}' '${f.script}'`, opts);
        if (result.kind === 'spawn-error') throw result.error;
        return result.stdout;
      });
      expect(JSON.parse(stdout) as unknown).toEqual(f.expected);
      expect(f.context.pendingChildren).toBe(0);
    } finally {
      await f.context.close();
    }
  },
);

test('retired inherited context refuses dispatch (mutation: omit context liveness validation)', async () => {
  const f = await fixture();
  await f.context.close();
  expect(() => f.context.run(() => checkoutWriterStdio(['pipe', 'pipe', 'pipe']))).toThrow(
    /expired/,
  );
});

test('outside review context preserves stdin stdout stderr (mutation: append unconditional descriptors)', () => {
  expect(checkoutWriterStdio(['ignore', 'pipe', 'inherit'])).toEqual(['ignore', 'pipe', 'inherit']);
});

test('unbegun context refuses spawn snapshot (mutation: omit durable-admission guard)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-writer-'));
  roots.push(root);
  const context = new CheckoutWriterContext(acquireSlot);
  try {
    expect(() => context.run(() => checkoutWriterStdio(['pipe', 'pipe', 'pipe']))).toThrow(
      /no held slots/,
    );
    await context.acquire(root, 1);
    expect(() => context.run(() => checkoutWriterStdio(['pipe', 'pipe', 'pipe']))).toThrow(
      /not yet durable/,
    );
  } finally {
    await context.close();
  }
});

test('post-spawn error does not drain a live child (mutation: settle tracking on error)', async () => {
  const f = await fixture();
  const child = f.context.run(() =>
    spawnAcpProcess({
      command: process.execPath,
      args: ['-e', "console.log('ready');process.stdin.resume()"],
      cwd: f.root,
      env: {},
    }),
  );
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  try {
    await once(child.stdout!, 'data');
    child.on('error', () => {});
    child.emit('error', new Error('post-spawn fault'));
    await Promise.resolve();
    await expect(f.context.close()).rejects.toThrow(/not closed/);
  } finally {
    child.kill('SIGKILL');
    await closed;
    await f.context.close().catch(() => undefined);
  }
});

test('external child-set mutation cannot bypass drain (mutation: expose the live child set)', async () => {
  const f = await fixture();
  const child = f.context.run(() =>
    spawnAcpProcess({
      command: process.execPath,
      args: ['-e', "console.log('ready');process.stdin.resume()"],
      cwd: f.root,
      env: {},
    }),
  );
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  try {
    await once(child.stdout!, 'data');
    const exposed: unknown = Reflect.get(f.context, 'children');
    if (exposed instanceof Set) exposed.clear();
    // A caller can add a similarly named field, but cannot alter the private tracker.
    Reflect.set(f.context, 'children', new Set());
    await expect(f.context.close()).rejects.toThrow(/not closed/);
    expect(f.context.pendingChildren).toBe(1);
  } finally {
    child.kill('SIGKILL');
    await closed;
    await f.context.close().catch(() => undefined);
  }
});

test('begin compensation restores verified checkout binding (mutation: default checkout pre-state to unbound)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-writer-'));
  roots.push(root);
  const checkoutPath = join(root, 'checkout');
  const checkoutGitDir = join(checkoutPath, '.git');
  await mkdir(checkoutGitDir, { recursive: true });
  const context = new CheckoutWriterContext(async (common, key) => {
    const slot = await acquireSlot(common, key);
    if (key !== 2) return slot;
    return {
      ...slot,
      async writeMetadata(metadata) {
        if (metadata.incomplete) throw new Error('injected second-slot persistence failure');
        await slot.writeMetadata(metadata);
      },
    };
  });
  try {
    const checkout = await context.acquire(root, { checkoutPath, checkoutGitDir });
    const pr = await context.acquire(root, 2);
    expect(await checkout.readMetadata()).toBeUndefined();
    expect(await pr.readMetadata()).toBeUndefined();
    await expect(context.begin()).rejects.toThrow(/injected second-slot/);
    expect(await checkout.readMetadata()).toEqual({
      version: 1,
      state: 'bound',
      incomplete: false,
      checkoutPath: await realpath(checkoutPath),
      checkoutGitDir: await realpath(checkoutGitDir),
    });
    expect(await pr.readMetadata()).toEqual({ version: 1, state: 'unbound', incomplete: false });
    expect(() => context.run(() => checkoutWriterStdio(['pipe', 'pipe', 'pipe']))).toThrow(
      /not yet durable/,
    );
  } finally {
    await context.close();
  }
});

test.each(['controlled-child', 'checkout-mutator'] as const)(
  'parent %s mutation prevents child compensation (mutation: ignore parent mutation state)',
  async (boundary) => {
    const f = await fixture();
    const child = new CheckoutWriterContext(async (common, key) => {
      const slot = await acquireSlot(common, key);
      return key === 4
        ? {
            ...slot,
            writeMetadata: async () => {
              throw new Error('injected child persistence failure');
            },
          }
        : slot;
    }, f.context);
    try {
      // A real writer boundary has already run in the original coordination context.
      if (boundary === 'controlled-child')
        await f.context.run(() => makeGhRunner({ bin: process.execPath })([f.script]));
      else f.context.markCheckoutMutation();
      const earlier = await child.acquire(f.root, 3);
      await child.acquire(f.root, 4);
      await expect(child.begin()).rejects.toThrow('injected child persistence failure');
      expect((await earlier.readMetadata())?.incomplete).toBe(true);
    } finally {
      await child.close();
      await f.context.close();
    }
  },
);

test.each([
  {
    name: 'nonzero',
    code: 23,
    script: "process.stdout.write('out');process.stderr.write('err');process.exit(23)",
    maxBuffer: 4096,
    mutation: 'ignore nonzero exit',
  },
  {
    name: 'overflow',
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    script: "process.stdout.write('x'.repeat(8192))",
    maxBuffer: 32,
    mutation: 'omit capture overflow fault',
  },
  {
    name: 'spawn fault',
    code: 'ENOENT',
    script: '',
    maxBuffer: 4096,
    mutation: 'discard spawn error',
  },
])(
  'collector preserves $name failure (mutation: $mutation)',
  async ({ name, code, script, maxBuffer }) => {
    const f = await fixture();
    try {
      await expect(
        f.context.run(() =>
          checkoutWriterCommand(
            name === 'spawn fault' ? join(f.root, 'missing') : process.execPath,
            ['-e', script],
            { maxBuffer },
          ),
        ),
      ).rejects.toMatchObject({ code });
      await expect.poll(() => f.context.pendingChildren).toBe(0);
    } finally {
      await f.context.close().catch(() => undefined);
    }
  },
);

test('effects preserves ran nonzero verdict and streams (mutation: return zero for a nonzero command)', async () => {
  const f = await fixture();
  try {
    const result = await f.context.run(() =>
      makeSubprocessDevEffects(f.root).runCommand(
        process.execPath,
        ['-e', "process.stdout.write('out');process.stderr.write('err');process.exit(23)"],
        { timeoutMs: 5000 },
      ),
    );
    expect(result).toEqual({ exitCode: 23, stdout: 'out', stderr: 'err', timedOut: false });
  } finally {
    await f.context.close().catch(() => undefined);
  }
});
