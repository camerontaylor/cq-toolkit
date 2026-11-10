// Offline local measurement evidence bundle — measurement slice M8a. Explicit
// roots plus Git-common-dir receipts; clean bytes survive scanning unchanged
// (source/stored SHA-256, journal bytes never parsed), absent expected files
// are inventoried as missing, restore resolves only available pointers, and a
// missing session index stays unknown. Offline JS tooling: no network.
// Explicit roots are canonicalized once (including macOS /tmp and /var aliases);
// only symlinks BELOW those canonical roots are rejected. For receipts the
// explicit root is commonDir; cq-review-address is a checked child, never a root.
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
const policy = parse(
  await readFile(new URL('../policy/denylist/patterns.yml', import.meta.url), 'utf8'),
);
const POLICY_SECRET_IDS = [
  'class:route-key-material',
  'class:token-ssh-plumbing',
  'class:inline-secret-assignments',
];
// Fail closed: a renamed or dropped rule would silently weaken redaction.
// Check presence per id, not the count, so a duplicate cannot hide a gap.
const missingSecretIds = POLICY_SECRET_IDS.filter(
  (id) => !policy.rules.some((rule) => rule.id === id),
);
if (missingSecretIds.length > 0)
  throw new Error(
    `measurement-bundle: policy/denylist/patterns.yml lacks required rule(s): ${missingSecretIds.join(', ')}`,
  );
const POLICY_SECRETS = policy.rules
  .filter((rule) => POLICY_SECRET_IDS.includes(rule.id))
  .map((rule) => new RegExp(rule.regex, 'g'));
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const BUNDLE_VERSION = 1;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REL = /^(?!\/)(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\\0]+$/;
const RECEIPTS_DIR = 'cq-review-address';
const SECRET_ENV_SUFFIXES = ['_TOKEN', '_SECRET', '_KEY', '_PASSWORD', '_URL', '_CREDENTIALS'];
// Policy patterns remain authoritative. Archive-local extensions cover quoted
// JSON (the policy assignment rule excludes quotes) and provider encodings without
// broadening the repository publish policy. The name set mirrors that rule.
const QUOTED_SECRET =
  /"[A-Za-z0-9_]*(?:token|secret|password|passphrase|api_key|apikey)[A-Za-z0-9_]*"\s*:\s*"(?:[^"\\]|\\.){12,}"/gi;
const ZAI_KEY = /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16}\b/gi;
const TOKEN_SHAPES = [
  QUOTED_SECRET,
  ZAI_KEY,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@?#"']+@/gi,
];

function scanEvidenceText(text) {
  let out = text;
  let redactionCount = 0;
  const replace = (pattern) => {
    out = out.replace(pattern, (match) => {
      redactionCount++;
      if (pattern === QUOTED_SECRET)
        return `${match.slice(0, match.indexOf('"', match.indexOf(':')) + 1)}[redacted]"`;
      return match.includes('://') ? match.slice(0, match.indexOf('://') + 3) : '[redacted]';
    });
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !value ||
      value.length < 8 ||
      /^(?:true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(value)
    )
      continue;
    if (!SECRET_ENV_SUFFIXES.some((suffix) => name.toUpperCase().endsWith(suffix))) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'));
  }
  // Remove complete PEM blocks before the policy's header-only match.
  for (const shape of [...TOKEN_SHAPES, ...POLICY_SECRETS]) replace(shape);
  return { text: out, redactionCount };
}

/** Scan without parsing or rewriting clean journal bytes. */
export function sanitizeEvidenceText(text) {
  return scanEvidenceText(text).text;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reasonOf = (error) =>
  sanitizeEvidenceText(error instanceof Error ? error.message : String(error));
const inside = (root, target) => target === root || target.startsWith(`${root}${sep}`);
const safeRelative = (rel) => typeof rel === 'string' && SAFE_REL.test(rel) && !rel.includes('//');

async function captureFile({ root, rootPath, rel, bundleDir, sourcePrefix = '' }) {
  const base = { root, path: rel };
  if (!safeRelative(rel)) return { ...base, state: 'rejected', reason: 'invalid relative path' };
  const sourceRel = sourcePrefix ? `${sourcePrefix}/${rel}` : rel;
  const source = resolve(rootPath, sourceRel);
  let raw;
  let handle;
  try {
    let component = rootPath;
    let sourceStat;
    for (const part of sourceRel.split('/')) {
      component = join(component, part);
      sourceStat = await lstat(component);
      if (sourceStat.isSymbolicLink() || (await realpath(component)) !== component)
        return { ...base, state: 'rejected', reason: 'symlink path component' };
    }
    if (!sourceStat.isFile())
      return { ...base, state: 'unavailable', reason: 'read failed (not a regular file)' };
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.dev !== sourceStat.dev || stat.ino !== sourceStat.ino)
      return { ...base, state: 'rejected', reason: 'source changed between lstat and open' };
    if (stat.size > MAX_FILE_BYTES)
      return { ...base, state: 'unsupported', reason: 'exceeds 8 MiB size cap' };
    // Bound allocation even if a producer grows the file after stat.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      return { ...base, state: 'unsupported', reason: 'exceeds 8 MiB size cap' };
    if (length > stat.size)
      return { ...base, state: 'unsupported', reason: 'source grew during capture' };
    raw = buffer.subarray(0, length);
  } catch (error) {
    if (error?.code === 'ELOOP')
      return { ...base, state: 'rejected', reason: 'symlink encountered while opening source' };
    return {
      ...base,
      state: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
      reason:
        error?.code === 'ENOENT'
          ? 'expected file is absent'
          : `read failed (${error?.code ?? 'unknown'})`,
    };
  } finally {
    await handle?.close();
  }
  const text = raw.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(raw))
    return { ...base, state: 'unsupported', reason: 'not UTF-8 text; left unbundled' };
  const scanned = scanEvidenceText(text);
  const stored = scanned.redactionCount ? Buffer.from(scanned.text, 'utf8') : raw;
  const pointer = ['files', root, ...rel.split('/')].join('/');
  try {
    await mkdir(dirname(resolve(bundleDir, pointer)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(bundleDir, pointer), stored, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    return { ...base, state: 'unavailable', reason: `write failed (${error?.code ?? 'unknown'})` };
  }
  return {
    ...base,
    state: 'present',
    pointer,
    sha256: sha256(stored),
    sourceSha256: sha256(raw),
    ...(scanned.redactionCount ? { sanitized: true, redactionCount: scanned.redactionCount } : {}),
  };
}

/** Receipt files below `<gitCommonDir>/cq-review-address`, sorted; symlinks inventoried as rejected. */
async function receiptFiles(commonDir) {
  try {
    const rootPath = await realpath(commonDir);
    const root = join(rootPath, RECEIPTS_DIR);
    if ((await lstat(root)).isSymbolicLink())
      return { state: 'rejected', files: [], reason: 'symlink receipt path component' };
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    return { state: 'present', rootPath, files: files.sort() };
  } catch (error) {
    return {
      state: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
      files: [],
      reason: `receipt discovery failed (${error?.code ?? 'unknown'})`,
    };
  }
}

async function captureRoot(root, bundleDir) {
  const expected = [...new Set(root.files ?? [])].sort();
  if (!expected.length) return [];
  let rootPath;
  try {
    rootPath = await realpath(resolve(root.path ?? ''));
  } catch (error) {
    return expected.map((path) => ({
      root: root.name,
      path,
      state: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
      reason:
        error?.code === 'ENOENT'
          ? 'expected file is absent'
          : `root unavailable (${error?.code ?? 'unknown'})`,
    }));
  }
  const files = [];
  for (const rel of expected)
    files.push(await captureFile({ root: root.name, rootPath, rel, bundleDir }));
  return files;
}

async function captureSessionIndex(path, bundleDir, files) {
  if (path === undefined)
    return { state: 'unknown', reason: 'no session index was supplied; the index stays unknown' };
  const [captured] = await captureRoot(
    {
      name: 'session-index',
      path: dirname(resolve(path)),
      files: [basename(path)],
    },
    bundleDir,
  );
  files.push(captured);
  if (captured.state !== 'present')
    return { state: 'unknown', reason: `the session index is unavailable: ${captured.reason}` };
  const { root: _root, path: _path, ...rest } = captured;
  return rest;
}

/** Capture explicit roots and Git-common-dir receipts into one bundle. */
export async function buildMeasurementBundle(input) {
  const { runId } = input;
  if (typeof runId !== 'string' || !SAFE_NAME.test(runId))
    throw new Error(`measurement-bundle: runId must match ${SAFE_NAME.source}`);
  const stateHome = process.env['XDG_STATE_HOME']?.trim() || join(homedir(), '.local', 'state');
  let bundleDir = resolve(input.bundleRoot ?? join(stateHome, 'cq', 'measurement-bundles'), runId);
  const names = new Set(['git-common-dir', 'session-index']);
  for (const root of input.roots ?? []) {
    if (typeof root.name !== 'string' || !SAFE_NAME.test(root.name) || names.has(root.name))
      throw new Error('measurement-bundle: invalid, duplicate or reserved root name');
    names.add(root.name);
  }
  await mkdir(dirname(bundleDir), { recursive: true, mode: 0o700 });
  const finalDir = bundleDir;
  // A sibling reservation serializes builders without exposing a partial final bundle.
  const reservation = `${finalDir}.building`;
  try {
    await mkdir(reservation, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw Object.assign(
        new Error(
          `measurement-bundle: reservation exists at ${reservation}; if no builder is active, remove this stale reservation directory and retry`,
        ),
        { code: 'EEXIST' },
      );
    throw error;
  }
  let staging;
  try {
    try {
      await lstat(finalDir);
      throw Object.assign(new Error('measurement-bundle: target exists'), { code: 'EEXIST' });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    staging = await mkdtemp(join(dirname(finalDir), '.measurement-'));
    bundleDir = staging;
    const inputs = [...(input.roots ?? [])];
    const common = input.gitCommonDir === undefined ? undefined : resolve(input.gitCommonDir);
    const receipts =
      common === undefined
        ? { state: 'unavailable', reason: 'no Git common directory supplied', files: [] }
        : await receiptFiles(common);
    const files = [];
    for (const root of inputs) files.push(...(await captureRoot(root, bundleDir)));
    for (const rel of receipts.files)
      files.push(
        await captureFile({
          root: 'git-common-dir',
          rootPath: receipts.rootPath,
          sourcePrefix: RECEIPTS_DIR,
          rel,
          bundleDir,
        }),
      );
    const sessionIndex = await captureSessionIndex(input.sessionIndexPath, bundleDir, files);
    files.sort((a, b) => compare(a.root, b.root) || compare(a.path, b.path));
    const missing = files
      .filter((file) => file.state !== 'present')
      .map(({ root, path, state, reason }) => ({ root, path, state, reason }));
    const manifest = {
      bundleVersion: BUNDLE_VERSION,
      runId,
      files,
      missing,
      sessionIndex,
      receipts: { state: receipts.state, ...(receipts.reason ? { reason: receipts.reason } : {}) },
    };
    await writeFile(resolve(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(staging, finalDir);
    return { bundleDir: finalDir, manifest };
  } finally {
    await rmdir(reservation);
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function resolveStored(bundleDir, entry) {
  const target = resolve(bundleDir, entry.pointer);
  if (!inside(resolve(bundleDir), target))
    return { state: 'unavailable', reason: 'bundle pointer escapes the bundle' };
  let real;
  try {
    real = await realpath(target);
  } catch (error) {
    return {
      state: 'unavailable',
      reason:
        error?.code === 'ENOENT'
          ? 'the bundle pointer is absent on disk'
          : `the bundle pointer could not be read: ${reasonOf(error)}`,
    };
  }
  // A symlinked pointer can pass the lexical check but resolve outside the bundle.
  if (!inside(await realpath(resolve(bundleDir)), real))
    return { state: 'unavailable', reason: 'bundle pointer escapes the bundle' };
  let bytes;
  try {
    bytes = await readFile(real);
  } catch (error) {
    return {
      state: 'unavailable',
      reason:
        error?.code === 'ENOENT'
          ? 'the bundle pointer is absent on disk'
          : `the bundle pointer could not be read: ${reasonOf(error)}`,
    };
  }
  if (sha256(bytes) !== entry.sha256)
    return { state: 'unavailable', reason: 'stored checksum does not match the manifest' };
  return { state: 'present', resolvedPath: target };
}

/** Resolve available pointers deterministically; absence stays unknown. */
export async function restoreMeasurementBundle(bundleDir) {
  const root = resolve(bundleDir);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest?.bundleVersion !== BUNDLE_VERSION)
    throw new Error(`measurement-bundle: unsupported bundleVersion ${manifest?.bundleVersion}`);
  const files = [];
  for (const entry of manifest.files ?? []) {
    if (entry.state !== 'present') files.push({ ...entry });
    else if (typeof entry.pointer !== 'string')
      files.push({
        ...entry,
        state: 'unavailable',
        reason: 'manifest entry lacks a bundle pointer',
      });
    else files.push({ ...entry, ...(await resolveStored(root, entry)) });
  }
  let sessionIndex = { ...manifest.sessionIndex };
  if (sessionIndex.state === 'present') {
    const resolved =
      typeof sessionIndex.pointer === 'string'
        ? await resolveStored(root, sessionIndex)
        : { state: 'unavailable', reason: 'manifest entry lacks a bundle pointer' };
    sessionIndex =
      resolved.state === 'present'
        ? { ...sessionIndex, ...resolved }
        : {
            state: 'unknown',
            reason: `the bundled session index is unavailable: ${resolved.reason}`,
          };
  }
  const pointers = Object.fromEntries(
    files
      .filter((file) => file.state === 'present')
      .map((file) => [`${file.root}/${file.path}`, file.resolvedPath]),
  );
  return {
    runId: manifest.runId,
    files,
    pointers,
    unavailable: files.filter((file) => file.state !== 'present'),
    sessionIndex,
  };
}
