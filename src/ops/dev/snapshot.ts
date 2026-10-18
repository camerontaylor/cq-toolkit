import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_CONTENT = 4 * 1024 * 1024;
const MAX_OBJECTS = 4096;
const MAX_WIRE = 6 * 1024 * 1024;

/** Private object-only capture: never changes HEAD, the index or working files. */
export async function captureSnapshot(repo: string, base: string, tree: string, scanner?: string) {
  if (![base, tree].every((oid) => /^[0-9a-f]{40}$/.test(oid)))
    throw new Error('invalid snapshot identity');
  if (!scanner?.startsWith('/'))
    throw new Error('configure an absolute snapshot scanner executable');
  const deadline = Date.now() + 30_000;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
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
  const commit = Buffer.from(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
  );
  const head = (await git(['hash-object', '-w', '-t', 'commit', '--stdin'], commit))
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
  for (const oid of ids) {
    const type = (await git(['cat-file', '-t', oid])).toString().trim();
    if (!['blob', 'tree', 'commit'].includes(type)) throw new Error('invalid snapshot object');
    const size = Number((await git(['cat-file', '-s', oid])).toString().trim());
    total += size;
    if (!Number.isSafeInteger(size) || size < 0 || total > MAX_CONTENT)
      throw new Error('snapshot content exceeds bound');
    const data = (await git(['cat-file', type, oid])).toString('base64');
    objects.push({ oid, type, data });
    digest.update(oid + '\0' + type + '\0' + data + '\n');
  }
  // Operator-owned executable, no shell. It must scan all outgoing object content,
  // including binary/untracked content, and exit nonzero on refusal or tool error.
  await new Promise<void>((resolve, reject) => {
    execFile(scanner, [repo, base, head], { env, timeout: 30_000, maxBuffer: 8192 }, (error) =>
      error ? reject(new Error('snapshot pre-upload scan refused')) : resolve(),
    );
  });
  const snapshot = { v: 1 as const, tree, objects, sha256: digest.digest('hex') };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_WIRE - 8192)
    throw new Error('snapshot wire exceeds bound');
  return { head, snapshot };
}

export function snapshotHead(base: string, tree: string): string {
  const body = Buffer.from(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
  );
  return createHash('sha1')
    .update(Buffer.from(`commit ${body.length}\0`))
    .update(body)
    .digest('hex');
}
