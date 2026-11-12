import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const MAX_CONTENT = 4 * 1024 * 1024;
const MAX_OBJECTS = 4096;
const MAX_WIRE = 6 * 1024 * 1024;

/** Operator misconfiguration (not a runtime refusal): surfaces as needs-human, never indeterminate. */
export class SnapshotConfigError extends Error {}

/** Private object-only capture: never changes HEAD, the index or working files. */
export async function captureSnapshot(
  repo: string,
  base: string,
  tree: string,
  scanner?: string,
  scanTimeoutMs = 30_000,
  originalHead?: string,
) {
  if (![base, tree].every((oid) => /^[0-9a-f]{40}$/.test(oid)))
    throw new Error('invalid snapshot identity');
  if (!scanner?.startsWith('/'))
    throw new SnapshotConfigError('configure an absolute snapshot scanner executable');
  const deadline = Date.now() + 30_000;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // The scanner must see the same objects as capture, never attacker-chosen refs/replace.
    GIT_NO_REPLACE_OBJECTS: '1',
  });
  const git = (args: string[], input?: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
      const timeout = deadline - Date.now();
      if (timeout <= 0) {
        reject(new Error('snapshot capture timeout'));
        return;
      }
      const child = execFile(
        'git',
        [
          '--no-replace-objects',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        { cwd: repo, env, encoding: 'buffer', timeout, maxBuffer: MAX_WIRE },
        (error, stdout) =>
          error ? reject(new Error('snapshot Git operation refused')) : resolve(stdout),
      );
      child.stdin?.on('error', () => {
        /* execFile callback reports failure */
      });
      child.stdin?.end(input);
    });
  if (
    (await git(['cat-file', '-t', base])).toString().trim() !== 'commit' ||
    (await git(['cat-file', '-t', tree])).toString().trim() !== 'tree'
  )
    throw new Error('snapshot requires a commit base and tree');
  if (originalHead !== undefined && !/^[0-9a-f]{40}$/.test(originalHead))
    throw new Error('invalid original head');
  const head =
    originalHead ??
    (await git(['hash-object', '-w', '-t', 'commit', '--stdin'], commitBody(base, tree)))
      .toString()
      .trim();
  if ((await git(['rev-parse', head + '^{tree}'])).toString().trim() !== tree)
    throw new Error('original head tree mismatch');
  const ids = (await git(['rev-list', '--objects', '--no-object-names', head, '^' + base]))
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  if (ids.length > MAX_OBJECTS) throw new Error('too many snapshot objects');
  const objects: { oid: string; type: string; data: string }[] = [];
  let total = 0;
  const digest = createHash('sha256');
  // One batched read for every object, in sorted-id order; each header is validated before its body is taken.
  const out = ids.length
    ? await git(['cat-file', '--batch'], Buffer.from(ids.join('\n') + '\n'))
    : Buffer.alloc(0);
  let pos = 0;
  for (const oid of ids) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('invalid snapshot object');
    const [gotOid, type, sizeText] = out.subarray(pos, nl).toString().split(' ');
    if (gotOid !== oid || !['blob', 'tree', 'commit'].includes(type ?? ''))
      throw new Error('invalid snapshot object');
    const size = Number(sizeText);
    total += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      total > (originalHead === undefined ? MAX_CONTENT : 3 * 1024 * 1024)
    )
      throw new Error('snapshot content exceeds bound');
    if (nl + 1 + size >= out.length) throw new Error('invalid snapshot object');
    const data = out.subarray(nl + 1, nl + 1 + size).toString('base64');
    pos = nl + 1 + size + 1;
    objects.push({ oid, type: type!, data });
    digest.update(oid + '\0' + type + '\0' + data + '\n');
  }
  // Operator-owned executable, no shell. It must scan all outgoing object content,
  // including binary/untracked content, and exit nonzero on refusal or tool error.
  await new Promise<void>((resolve, reject) => {
    // Own process group, SIGKILLed at the deadline and on every exit: a scanner that traps
    // SIGTERM or backgrounds children must not outlive its budget or keep reading the repo.
    // Its output is never reflected, so stdio is discarded.
    const child = spawn(scanner, [repo, base, head], { env, detached: true, stdio: 'ignore' });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group has already exited */
      }
    };
    const timer = setTimeout(killGroup, scanTimeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code)))
        reject(new SnapshotConfigError('snapshot scanner is missing or not executable'));
      else reject(new Error('snapshot pre-upload scan refused'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      killGroup();
      if (code === 0) resolve();
      else reject(new Error('snapshot pre-upload scan refused'));
    });
  });
  const snapshot = { v: 1 as const, tree, objects, sha256: digest.digest('hex') };
  if (
    Buffer.byteLength(JSON.stringify(snapshot)) >
    (originalHead === undefined ? MAX_WIRE - 8192 : 5 * 1024 * 1024)
  )
    throw new Error('snapshot wire exceeds bound');
  return { head, snapshot };
}

/** The deterministic synthetic commit binding `tree` to `base` (ops/tree-snapshots.md). */
function commitBody(base: string, tree: string): Buffer {
  return Buffer.from(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
  );
}

export function snapshotHead(base: string, tree: string): string {
  const body = commitBody(base, tree);
  return createHash('sha1')
    .update(Buffer.from(`commit ${body.length}\0`))
    .update(body)
    .digest('hex');
}

/** Capture the final disk tree with a private index; never alter the author index or refs. */
export async function captureWorkingTree(repo: string, originalHead: string) {
  if (!/^[0-9a-f]{40}$/.test(originalHead)) throw new Error('invalid working-tree head');
  const temporary = await mkdtemp(join(tmpdir(), 'cq-working-tree-'));
  const index = join(temporary, 'index');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_INDEX_FILE: index,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(
        'git',
        [
          '--no-replace-objects',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        { cwd: repo, env, timeout: 30_000, maxBuffer: MAX_WIRE },
      )
    ).stdout;
  const object = async (type: string, content: Buffer) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['--no-replace-objects', 'hash-object', '-w', '-t', type, '--stdin'],
        { cwd: repo, env, timeout: 30_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      child.stdin?.on('error', () => {
        /* callback reports failure */
      });
      child.stdin?.end(content);
    });
  try {
    const realEnv = { ...env };
    delete realEnv['GIT_INDEX_FILE'];
    const flags = (
      await promisify(execFile)(
        'git',
        ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'ls-files', '-v', '-z'],
        {
          cwd: repo,
          env: realEnv,
          timeout: 30_000,
          maxBuffer: MAX_WIRE,
        },
      )
    ).stdout;
    if (flags.split('\0').some((entry) => /^[Ss] /.test(entry)))
      throw new Error(
        'sparse or skip-worktree checkout cannot be captured — materialize the full checkout first',
      );
    const entries = (
      await promisify(execFile)(
        'git',
        ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z'],
        { cwd: repo, env: realEnv, timeout: 30_000, maxBuffer: MAX_WIRE },
      )
    ).stdout;
    await git('read-tree', '--empty');
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'git',
        ['--no-replace-objects', 'update-index', '-z', '--index-info'],
        { cwd: repo, env, timeout: 30_000 },
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.on('error', () => {
        /* callback reports failure */
      });
      child.stdin?.end(entries);
    });
    const stagedTree = (await git('write-tree')).trim();
    const tracked = (await git('ls-files', '-z')).split('\0').filter(Boolean);
    const untracked = (
      await git('ls-files', '-z', '--others', '--exclude-standard', '--exclude=/.cq/')
    )
      .split('\0')
      .filter(Boolean);
    const indexed = new Map(
      entries
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf('\t');
          const [mode, oid] = entry.slice(0, tab).split(' ');
          return [entry.slice(tab + 1), { mode, oid }];
        }),
    );
    for (const path of new Set([...tracked, ...untracked])) {
      // Operational artifacts are never captured, even in adopter repositories.
      if (path === '.cq' || path.startsWith('.cq/')) {
        await git('update-index', '--force-remove', '--', path);
        continue;
      }
      let info;
      try {
        const parents = path.split('/').slice(0, -1);
        for (let end = 1; end <= parents.length; end++) {
          const parent = await lstat(join(repo, ...parents.slice(0, end)));
          if (!parent.isDirectory())
            throw new Error(`working-tree snapshot refuses non-directory ancestor: ${path}`);
        }
        info = await lstat(join(repo, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await git('update-index', '--force-remove', '--', path);
        continue;
      }
      if (info.isDirectory() && indexed.get(path)?.mode !== '160000') {
        await git('update-index', '--force-remove', '--', path);
        continue;
      }
      const trackedLink = info.isSymbolicLink() && indexed.has(path);
      if (!info.isFile() && !trackedLink)
        throw new Error(`working-tree snapshot refuses non-regular path: ${path}`);
      if (info.size > MAX_CONTENT) {
        // Large unchanged base blobs need no transfer; do not load them into memory.
        const oid = (await git('hash-object', '--no-filters', '--', path)).trim();
        if (
          indexed.get(path)?.oid === oid &&
          indexed.get(path)?.mode === (info.mode & 0o111 ? '100755' : '100644')
        )
          continue;
        throw new Error('working-tree snapshot file exceeds bound');
      }
      const content = trackedLink
        ? Buffer.from(await readlink(join(repo, path)))
        : await readFile(join(repo, path));
      const mode = trackedLink ? '120000' : info.mode & 0o111 ? '100755' : '100644';
      const digest = createHash('sha1')
        .update(Buffer.from(`blob ${content.length}\0`))
        .update(content)
        .digest('hex');
      if (indexed.get(path)?.oid === digest && indexed.get(path)?.mode === mode) continue;
      const blob = await object('blob', content);
      await git('update-index', '--add', '--cacheinfo', mode, blob, path);
    }
    const tree = (await git('write-tree')).trim();
    const head = await object('commit', commitBody(originalHead, tree));
    return { head, tree, stagedTree };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
