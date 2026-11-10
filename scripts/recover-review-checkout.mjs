import { spawn, execFile } from 'node:child_process';
import { open, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

async function canonicalizeMissing(path, io) {
  let current = path;
  const missing = [];
  for (;;) {
    try {
      return join(await io.realpath(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink is not an absent path and must not certify removal.
      try {
        await io.lstat(current);
        throw new Error(`Unresolvable path alias: ${current}`);
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Run recovery with injectable IO; all metadata writes use the slot protocol. */
export async function recoverReviewCheckout(env, io) {
  if (!env.CQ_RECOVERY_LOCKS || !env.CQ_RECOVERY_CHECKOUT)
    throw new Error('Recovery locks and checkout are required');
  const paths = JSON.parse(env.CQ_RECOVERY_LOCKS);
  const checkout = env.CQ_RECOVERY_CHECKOUT;
  const mode = env.CQ_RECOVERY_MODE || 'inspect';
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    !isAbsolute(checkout) ||
    !['inspect', 'retain', 'removed'].includes(mode)
  )
    throw new Error('Invalid recovery arguments');
  const slots = [];
  const seen = new Set();
  try {
    for (const path of paths) {
      if (
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        !/^(?:pr-[1-9][0-9]*|checkout-[a-f0-9]{64})\.lock$/.test(basename(path))
      )
        throw new Error(`Invalid lock path: ${path}`);
      const parent = await io.realpath(dirname(path));
      if (
        basename(parent) !== 'slots' ||
        basename(dirname(parent)) !== 'cq-review' ||
        parent !== dirname(path)
      )
        throw new Error(`Invalid lock parent: ${path}`);
      const named = join(parent, basename(path));
      if (seen.has(named)) continue;
      seen.add(named);
      const info = await io.lstat(named);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid lock inode: ${named}`);
      const slot = io.attach(await io.acquire(named));
      slots.push(slot);
      const locked = await io.lstat(named);
      if (info.dev !== locked.dev || info.ino !== locked.ino)
        throw new Error(`Lock inode changed during acquisition: ${named}`);
      await slot.assertIdentity();
    }
    let invalid = false;
    const metadata = [];
    for (const slot of slots) {
      try {
        const value = await slot.readMetadata();
        io.print(`${slot.metadataPath}: ${JSON.stringify(value)}`);
        if (!value) invalid = true;
        metadata.push(value);
      } catch (error) {
        invalid = true;
        metadata.push(undefined);
        io.print(`${slot.metadataPath}: ${error.message}`);
      }
    }
    const success = await io.shell(slots.map((slot) => slot.fd));
    if (!success || mode === 'inspect') return;
    if (invalid) throw new Error('Missing or malformed metadata permits inspection only');
    if ((await io.acknowledge()) !== 'quiescent-and-reconciled') return;
    for (const slot of slots) await slot.assertIdentity();
    let next;
    if (mode === 'removed') {
      if ((await canonicalizeMissing(dirname(checkout), io)) !== dirname(checkout))
        throw new Error(`Checkout parent alias refused: ${checkout}`);
      if (metadata.some((entry) => entry.state === 'bound' && entry.checkoutPath !== checkout))
        throw new Error('Removed checkout does not match prior bound identity');
      try {
        await io.lstat(checkout);
        throw new Error(`Checkout still exists: ${checkout}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      next = { version: 1, state: 'unbound', incomplete: false };
    } else {
      const identity = await io.checkoutIdentity(checkout);
      if (
        !metadata.some(
          (entry) =>
            entry.state === 'bound' &&
            entry.checkoutPath === identity.checkoutPath &&
            entry.checkoutGitDir === identity.checkoutGitDir,
        )
      )
        throw new Error('Retained checkout does not match prior bound identity');
      if (
        metadata.some(
          (entry) =>
            entry.state === 'bound' &&
            (entry.checkoutPath !== identity.checkoutPath ||
              entry.checkoutGitDir !== identity.checkoutGitDir),
        )
      )
        throw new Error('Conflicting prior checkout identities');
      const checkoutName = `checkout-${createHash('sha256').update(identity.checkoutGitDir).digest('hex')}.lock`;
      for (const slot of slots) {
        if (
          basename(slot.path).startsWith('checkout-') &&
          (basename(slot.path) !== checkoutName ||
            dirname(slot.path) !== join(identity.commonDir, 'cq-review', 'slots'))
        )
          throw new Error(`Checkout slot identity mismatch: ${slot.path}`);
      }
      next = {
        version: 1,
        state: 'bound',
        incomplete: false,
        checkoutPath: identity.checkoutPath,
        checkoutGitDir: identity.checkoutGitDir,
      };
    }
    for (const slot of [...slots].reverse()) {
      try {
        await slot.writeMetadata(next);
      } catch (cause) {
        throw new Error(`Recovery write failed: ${slot.metadataPath}; remaining slots untouched`, {
          cause,
        });
      }
    }
  } finally {
    for (const slot of slots.reverse()) await slot.close();
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Recovery accepts no arguments');
  const { acquireFileLock, attachSlotMetadata } = await import('../dist/adapters/lock/slotLock.js');
  const tty = await open('/dev/tty', 'r+');
  const git = async (path, args) =>
    (await exec('git', ['-C', path, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    await recoverReviewCheckout(process.env, {
      realpath,
      lstat,
      acquire: acquireFileLock,
      attach: attachSlotMetadata,
      print: (message) => console.log(message),
      shell: (fds) =>
        new Promise((resolveShell, reject) => {
          const child = spawn('/bin/sh', ['-i'], { stdio: [tty.fd, tty.fd, tty.fd, ...fds] });
          child.once('error', reject);
          child.once('close', (code, signal) => resolveShell(code === 0 && !signal));
        }),
      acknowledge: async () => {
        await tty.write('Type quiescent-and-reconciled to clear: ');
        const bytes = Buffer.alloc(256);
        const { bytesRead } = await tty.read(bytes, 0, bytes.length, null);
        return bytes.subarray(0, bytesRead).toString().trim();
      },
      checkoutIdentity: async (path) => {
        const checkoutPath = await realpath(path);
        if (checkoutPath !== resolve(path)) throw new Error('Checkout alias refused');
        const checkoutGitDir = await realpath(
          await git(path, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']),
        );
        const commonDir = await realpath(
          await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        );
        if (await git(path, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']))
          throw new Error('Checkout is not clean');
        return { checkoutPath, checkoutGitDir, commonDir };
      },
    });
  } finally {
    await tty.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
