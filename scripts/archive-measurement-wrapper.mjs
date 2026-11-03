// Measurement archive transport — measurement slice M8b. Transport only: a
// validated M8a bundle is checked against the configured session archive,
// copied to <target>/<host>/measurement/<runId> with manifest.json as the
// commit marker, then verified with `rclone check --one-way`. The copy is
// append-only (`copy --immutable`, never `sync`/`--delete`); the bundle is
// read-only and the session manifest is never written. If the archive check,
// copy, commit or verification fails, the result says so and names the
// untouched local bundle as the explicit fallback. Reasons are sanitized;
// command lines carry no env values.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { sanitizeEvidenceText } from './archive-measurement-evidence.mjs';

const execFileAsync = promisify(execFile);
const RCLONE = 'rclone';
const RCLONE_TIMEOUT_MS = 5 * 60 * 1000;
const BUNDLE_VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_SEGMENT = /^[A-Za-z0-9._:-]+$/;
const REMOTE_NAME = /^[A-Za-z0-9_-]+$/;
/** A non-empty relative path: `rel/dir` has no remote and `remote:` no path. */
const PATH_START = /^[A-Za-z0-9._-]/;
/** The first line naming a failure, else the first line; sanitized, bounded. */
const reasonLine = (text, fallback) => {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const picked = lines.find((line) => /ERROR|Failed/.test(line)) ?? lines[0] ?? fallback ?? '';
  return sanitizeEvidenceText(picked).slice(0, 300);
};
const targetOf = (target) => target.replace(/\/+$/, '');

function validTarget(target) {
  if (typeof target !== 'string' || !target || target !== target.trim()) return false;
  if (target.startsWith('-') || target.startsWith(':') || /[\s\0]/.test(target)) return false;
  const colon = target.indexOf(':');
  if (colon <= 0) return false;
  // A named remote plus a non-empty path: `rel/dir` writes to local disk, a
  // connection string starts with ':', and a bare `remote:` is the root on sftp.
  const path = targetOf(target).slice(colon + 1);
  return (
    REMOTE_NAME.test(target.slice(0, colon)) &&
    PATH_START.test(path) &&
    path.split('/').every((part) => part !== '.' && part !== '..' && TARGET_SEGMENT.test(part))
  );
}

async function runRclone(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: RCLONE_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // A spawn failure (missing rclone, timeout) carries a string code; keep it
    // so the caller can report the archive as unknown rather than unavailable.
    const code = error?.code;
    return {
      code: typeof code === 'number' || typeof code === 'string' ? code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr || error?.message || ''),
    };
  }
}

/** Read the bundle manifest without following links or mutating the bundle. */
async function readBundle(bundleDir) {
  if (typeof bundleDir !== 'string' || !bundleDir)
    return { state: 'rejected', reason: 'no bundle directory was supplied' };
  let handle;
  try {
    const root = await realpath(resolve(bundleDir));
    if (!(await lstat(root)).isDirectory())
      return { state: 'rejected', reason: 'the bundle is not a directory' };
    // lstat first: opening a FIFO O_RDONLY blocks forever. Then confirm the
    // opened descriptor is the same regular file, as M8a does for sources.
    const manifestPath = join(root, 'manifest.json');
    const before = await lstat(manifestPath);
    if (!before.isFile())
      return { state: 'rejected', reason: 'the bundle manifest is not a regular file' };
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      return { state: 'rejected', reason: 'the bundle manifest changed before it was read' };
    if (stat.size > MAX_MANIFEST_BYTES)
      return { state: 'rejected', reason: 'the bundle manifest exceeds 8 MiB' };
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size)
      return { state: 'rejected', reason: 'the bundle manifest grew during read' };
    const manifest = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (
      manifest?.bundleVersion !== BUNDLE_VERSION ||
      typeof manifest.runId !== 'string' ||
      !SAFE_NAME.test(manifest.runId)
    )
      return { state: 'rejected', reason: 'the manifest is not a supported measurement bundle' };
    return { state: 'present', root, runId: manifest.runId };
  } catch (error) {
    if (error instanceof SyntaxError)
      return { state: 'rejected', reason: 'the bundle manifest is not valid JSON' };
    const code = error?.code;
    return {
      state: code === 'ENOENT' ? 'missing' : 'unavailable',
      reason:
        code === 'ENOENT'
          ? 'the bundle or its manifest is absent'
          : `the bundle could not be read (${code ?? 'unknown'})`,
    };
  } finally {
    await handle?.close();
  }
}

/** Archive one bundle. See docs/measurement/archive-install.md for the contract. */
export async function runMeasurementArchive(input = {}) {
  const target = input.target;
  const run = input.run ?? runRclone;
  const host = input.host ?? hostname();
  const result = {
    state: 'failed',
    runId: null,
    target: typeof target === 'string' ? target : null,
    host,
    localBundle: null,
    archive: { state: 'unknown', reason: 'the existing session archive was not checked' },
  };
  if (!validTarget(target))
    return { ...result, reason: 'measurement archive: no valid rclone target' };
  if (typeof host !== 'string' || !SAFE_NAME.test(host))
    return { ...result, reason: 'measurement archive: the host name is invalid' };
  const bundle = await readBundle(input.bundleDir);
  if (bundle.state !== 'present')
    return { ...result, reason: `measurement archive: ${bundle.reason}` };

  const destination = `${targetOf(target)}/${host}/measurement/${bundle.runId}`;
  const local = { ...result, runId: bundle.runId, localBundle: bundle.root, destination };
  const check = await run(RCLONE, ['lsf', targetOf(target), '--max-depth', '1']);
  if (check.code !== 0) {
    const reason = reasonLine(check.stderr, `rclone lsf exited ${check.code}`);
    // A string code means rclone never ran: the archive condition is unknown,
    // not unavailable.
    const ran = typeof check.code !== 'string';
    return {
      ...local,
      state: 'local',
      archive: { state: ran ? 'unavailable' : 'unknown', reason },
      reason: ran
        ? `the existing session archive is unavailable; evidence stays local: ${reason}`
        : `the session archive could not be checked; evidence stays local: ${reason}`,
    };
  }
  const copy = await run(RCLONE, [
    'copy',
    bundle.root,
    destination,
    '--immutable',
    '--transfers',
    '2',
    '--checkers',
    '2',
    '--low-level-retries',
    '4',
    '--no-update-modtime',
    '--exclude',
    '/manifest.json',
  ]);
  if (copy.code !== 0) {
    const reason = reasonLine(copy.stderr, `rclone copy exited ${copy.code}`);
    return {
      ...local,
      state: 'local',
      archive: { state: 'present', reason },
      reason: `rclone copy failed; evidence stays local and the remote may hold partial content: ${reason}`,
    };
  }
  // manifest.json is the commit marker: it only appears once the payload copy
  // has succeeded, so an interrupted push never looks like a whole bundle.
  const commit = await run(RCLONE, [
    'copyto',
    `${bundle.root}/manifest.json`,
    `${destination}/manifest.json`,
  ]);
  if (commit.code !== 0) {
    const reason = reasonLine(commit.stderr, `rclone copyto exited ${commit.code}`);
    return {
      ...local,
      state: 'local',
      archive: { state: 'present', reason },
      reason: `the archive commit marker could not be written; evidence stays local and the remote may hold partial content: ${reason}`,
    };
  }
  // rclone can skip a file with a NOTICE and still exit 0, so confirm what
  // actually reached the remote before reporting it archived.
  const verified = await run(RCLONE, ['check', bundle.root, destination, '--one-way']);
  if (verified.code === 0) return { ...local, state: 'archived', archive: { state: 'present' } };
  const reason = reasonLine(verified.stderr, `rclone check exited ${verified.code}`);
  return {
    ...local,
    state: 'local',
    archive: { state: 'present', reason },
    reason: `remote copy incomplete; evidence stays local: ${reason}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const value = args[args.indexOf(name) + 1];
    return args.includes(name) && !value?.startsWith('--') ? value : undefined;
  };
  const result = await runMeasurementArchive({
    bundleDir: option('--bundle'),
    target: option('--target'),
    host: option('--host'),
  });
  console.log(JSON.stringify(result));
  if (result.state !== 'archived') process.exitCode = 1;
}
