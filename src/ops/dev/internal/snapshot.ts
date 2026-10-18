import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

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
  const head = (await git(['hash-object', '-w', '-t', 'commit', '--stdin'], commitBody(base, tree)))
    .toString()
    .trim();
  const ids = (await git(['rev-list', '--objects', '--no-object-names', head, '^' + base]))
    .toString()
    .trim()
    .split(/\s+/)
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
    if (!Number.isSafeInteger(size) || size < 0 || total > MAX_CONTENT)
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
    // Own process group + SIGKILL of the whole group at the deadline: a scanner that traps
    // SIGTERM or backgrounds children must not outlive its budget or keep reading the repo.
    // Its output is never reflected, so stdio is discarded.
    const child = spawn(scanner, [repo, base, head], { env, detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, scanTimeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code)))
        reject(new SnapshotConfigError('snapshot scanner is missing or not executable'));
      else reject(new Error('snapshot pre-upload scan refused'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('snapshot pre-upload scan refused'));
    });
  });
  const snapshot = { v: 1 as const, tree, objects, sha256: digest.digest('hex') };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_WIRE - 8192)
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
