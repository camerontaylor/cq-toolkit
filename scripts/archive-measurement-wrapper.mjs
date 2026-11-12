// Measurement archive transport — measurement slice M8b. Transport only: a
// validated M8a bundle (every entry a regular file or directory, no symlinks)
// is checked against the configured session archive, copied to
// <target>/<host>/measurement/<runId>, verified with `rclone check --one-way`,
// and only then given manifest.json as the commit marker, which is confirmed
// by a final filtered check. The copy is append-only (`copy` with
// `--immutable`, never `sync`/`--delete`); the bundle is read-only and the
// session manifest is never written. If the archive check, copy, verification, commit or
// marker check fails, the result says so and names the untouched local
// bundle as the explicit fallback. Reasons are sanitized; command lines
// carry no env values.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
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
/** Bounds for the pre-flight tree walk; real bundles hold dozens of entries. */
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 40;
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

/**
 * Map an execFile failure onto the runner's result shape. Only ENOENT and
 * EACCES mean the binary never ran; any other failure — an exit code, the
 * maxBuffer abort — means it did. `killed` is set only when execFile killed
 * the child itself, which here is the timeout; a signal without it (OOM,
 * systemctl stop) is an external kill, not a timeout, and names its signal.
 */
export function mapRcloneFailure(error, args) {
  const timedOut = error?.killed === true;
  const signal = typeof error?.signal === 'string' ? error.signal : null;
  const code = error?.code;
  return {
    code: timedOut
      ? 'timeout'
      : (signal ?? (typeof code === 'number' || typeof code === 'string' ? code : 1)),
    stdout: String(error?.stdout ?? ''),
    stderr: timedOut
      ? `rclone ${args[0]} timed out after ${RCLONE_TIMEOUT_MS} ms`
      : signal
        ? `rclone ${args[0]} was killed by ${signal}`
        : String(error?.stderr || error?.message || ''),
  };
}

async function runRclone(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: RCLONE_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return mapRcloneFailure(error, args);
  }
}

/** Read the bundle manifest without following links or mutating the bundle. */
async function readBundle(bundleDir) {
  if (typeof bundleDir !== 'string' || !bundleDir)
    return { state: 'rejected', usage: true, reason: 'no bundle directory was supplied' };
  let handle;
  try {
    const root = await realpath(resolve(bundleDir));
    if (!(await lstat(root)).isDirectory())
      // A bundle path that names a file (or anything non-directory) is a
      // misconfigured invocation, not an archive failure: mark it as a usage
      // error so the CLI exits 2 (I1) instead of 1.
      return { state: 'rejected', usage: true, reason: 'the bundle is not a directory' };
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

/**
 * Walk the bundle with lstat, never following links (M8a's rule,
 * archive-measurement-evidence.mjs): every entry must be a regular file or a
 * directory, so `copy` can reproduce the tree faithfully and nothing can ride
 * along a symlink. Returns null when the tree is safe, else a reason.
 */
async function walkBundleTree(root) {
  let entries = 0;
  const walk = async (dir, depth) => {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      return `the bundle could not be walked (${error?.code ?? 'unknown'})`;
    }
    for (const name of names) {
      if (++entries > MAX_TREE_ENTRIES || depth >= MAX_TREE_DEPTH)
        return 'the bundle tree exceeds the walk bound';
      let stat;
      try {
        stat = await lstat(join(dir, name));
      } catch (error) {
        return `the bundle could not be walked (${error?.code ?? 'unknown'})`;
      }
      if (stat.isSymbolicLink()) return 'the bundle contains a symlink';
      if (stat.isDirectory()) {
        const failure = await walk(join(dir, name), depth + 1);
        if (failure) return failure;
      } else if (!stat.isFile()) {
        return 'the bundle contains a non-regular file';
      }
    }
    return null;
  };
  return walk(root, 0);
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
  // `usage` marks an input-validation failure — a misconfigured invocation —
  // so the CLI can exit 2 for it, as invariant I1 reserves, while a genuine
  // archive or transport failure stays exit 1.
  if (!validTarget(target))
    return { ...result, usage: true, reason: 'measurement archive: no valid rclone target' };
  if (typeof host !== 'string' || !SAFE_NAME.test(host))
    return { ...result, usage: true, reason: 'measurement archive: the host name is invalid' };
  const bundle = await readBundle(input.bundleDir);
  if (bundle.state !== 'present')
    return {
      ...result,
      ...(bundle.usage ? { usage: true } : {}),
      reason: `measurement archive: ${bundle.reason}`,
    };
  // Before any remote call: a symlink (or FIFO/device node) anywhere in the
  // tree is silently skipped by the rclone local backend, so it would never
  // reach the archive yet would not fail the copy either.
  const tree = await walkBundleTree(bundle.root);
  if (tree) return { ...result, reason: `measurement archive: ${tree}` };

  const destination = `${targetOf(target)}/${host}/measurement/${bundle.runId}`;
  const local = { ...result, runId: bundle.runId, localBundle: bundle.root, destination };
  const check = await run(RCLONE, ['lsf', targetOf(target), '--max-depth', '1']);
  if (check.code !== 0) {
    const reason = reasonLine(check.stderr, `rclone lsf exited ${check.code}`);
    // Only ENOENT/EACCES mean rclone never ran: the archive condition is
    // unknown. Every other failure — an exit code, the maxBuffer abort, a
    // timeout — means it ran and the archive could not be checked.
    const ran = check.code !== 'ENOENT' && check.code !== 'EACCES';
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
  // Verify the payload while the commit marker is still absent from the
  // remote: the manifest may only appear once everything else is confirmed
  // there. rclone can skip a file with a NOTICE and still exit 0, so confirm
  // what actually arrived. --copy-links is defence in depth: check follows a
  // local symlink instead of skipping it on both sides, so one the walk
  // missed surfaces as a missing remote file instead of a clean report.
  const payload = await run(RCLONE, [
    'check',
    bundle.root,
    destination,
    '--one-way',
    '--exclude',
    '/manifest.json',
    '--copy-links',
  ]);
  if (payload.code !== 0) {
    const reason = reasonLine(payload.stderr, `rclone check exited ${payload.code}`);
    return {
      ...local,
      state: 'local',
      archive: { state: 'present', reason },
      reason: `remote copy incomplete; evidence stays local: ${reason}`,
    };
  }
  // manifest.json is the commit marker: it only appears once the payload copy
  // has been verified, so an interrupted push never looks like a whole bundle.
  // The marker copy is directory-scoped with the payload copy's flags, because
  // a single-file copyto skips the --immutable check (rclone issue #4921):
  // with copyto, a re-run or a tampered remote silently overwrote the marker.
  // --include keeps it to the manifest alone; --immutable keeps the marker
  // append-only: a differing manifest fails instead of overwriting the archive.
  const commit = await run(RCLONE, [
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
    '--include',
    '/manifest.json',
  ]);
  if (commit.code !== 0) {
    const reason = reasonLine(commit.stderr, `rclone copy exited ${commit.code}`);
    return {
      ...local,
      state: 'local',
      archive: { state: 'present', reason },
      reason: `the archive commit marker could not be written; evidence stays local and the remote may hold partial content: ${reason}`,
    };
  }
  // Confirm the marker itself landed. check cannot compare single files, so
  // the tree comparison is filtered down to the manifest path.
  const verified = await run(RCLONE, [
    'check',
    bundle.root,
    destination,
    '--one-way',
    '--include',
    '/manifest.json',
    '--copy-links',
  ]);
  if (verified.code === 0) return { ...local, state: 'archived', archive: { state: 'present' } };
  const reason = reasonLine(verified.stderr, `rclone check exited ${verified.code}`);
  return {
    ...local,
    state: 'local',
    archive: { state: 'present', reason },
    reason: `the archived commit marker could not be verified; evidence stays local: ${reason}`,
  };
}

// Node normally resolves the main module's symlinks, but preserves its raw
// URL under --preserve-symlinks-main. Accept either form of the entry path.
const entry = process.argv[1] ? resolve(process.argv[1]) : null;
const realEntry = entry ? await realpath(entry).catch(() => null) : null;
if (
  entry &&
  (import.meta.url === pathToFileURL(entry).href ||
    (realEntry && import.meta.url === pathToFileURL(realEntry).href))
) {
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
  if (result.state !== 'archived') process.exitCode = result.usage ? 2 : 1;
}
