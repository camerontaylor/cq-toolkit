/**
 * Worktree verification and retention for `crq_repair.process` (slice 7):
 *
 * - {@link verifyRepairCommits} — `crq_repair/__init__.py:62-82` (`verify`);
 * - {@link retain} — `crq_repair/retain.py:56-107`;
 * - {@link untrackedDirectories} — `retain.py:110-119`;
 * - {@link retainPreservingNested} — `crq_repair.py:300-326`.
 *
 * Real effects, scoped to the worktree and evidence directory the caller
 * passes: `git` reads, and writes under `directory` only. Nothing here resets,
 * cleans or removes a worktree, and nothing imports this outside tests (no
 * unit is routed). `process()` remains Python until slice 8.
 *
 * Python fidelity kept: `git()` strips stdout and raises `RuntimeError`
 * (`git <sub> failed: <stderr[:200]>`); `subprocess.run(check=True)` failures
 * are `CalledProcessError`; `text=True` decodes strictly as UTF-8 with
 * universal newlines (a bad byte is a `UnicodeDecodeError`, a `ValueError`);
 * the commit-message check uses `(?<!\d)`/`(?!\d)`, where Python `\d` matches
 * every Unicode decimal digit.
 *
 * Divergence (pinned in test/adapters/crq/repairWorktreeCapture.test.ts): an
 * untracked file whose name is not valid UTF-8 is refused with a `ValueError`;
 * Python archives it through `os.fsdecode` surrogate escapes.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { JsonNumber } from '../../policy/crq/jsonValue.js';
import { receiptJsonDigest, atomicJsonText } from '../../policy/crq/pythonJson.js';
import { pyTruthy, pythonValueEqual } from '../../policy/crq/queueDoc.js';
import { pyStrip, splitlines } from '../../ops/crq/deploy/gitGuards.js';
import { isPyError, PyError } from '../../queue-runner/pyErrors.js';
import { untrackedTar } from './repairUntrackedTar.js';

const COMMAND_TIMEOUT_MS = 1_200_000;
const RAW_TIMEOUT_MS = 120_000;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(bytes: Buffer): string {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    throw new PyError('ValueError', "'utf-8' codec can't decode byte in git output");
  }
  // `text=True` is universal-newlines mode.
  return text.replace(/\r\n?/g, '\n');
}

interface Completed {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function spawn(cwd: string, args: readonly string[], timeout: number): Completed {
  const done = spawnSync('git', [...args], { cwd, timeout, maxBuffer: 1 << 30 });
  if (done.error) {
    const code = (done.error as NodeJS.ErrnoException).code;
    // `subprocess.run(timeout=...)` raises `TimeoutExpired`, a `SubprocessError`.
    if (code === 'ETIMEDOUT') {
      throw new PyError(
        'TimeoutExpired',
        `Command '['git', ${args.map((a) => `'${a}'`).join(', ')}]' timed out after ${timeout / 1000} seconds`,
      );
    }
    // A missing `git` binary is `FileNotFoundError` (an `OSError`) in Python.
    throw new PyError(code === 'ENOENT' ? 'FileNotFoundError' : 'OSError', done.error.message);
  }
  return { status: done.status ?? -1, stdout: done.stdout, stderr: done.stderr };
}

/** `crq_repair.command(['git', ...])`: the exit status is the caller's to read. */
function command(cwd: string, args: readonly string[]): { status: number } {
  return { status: spawn(cwd, args, COMMAND_TIMEOUT_MS).status };
}

/** `crq_repair.git(wt, *args)`: stripped stdout; `RuntimeError` on non-zero. */
function git(cwd: string, ...args: string[]): string {
  const done = spawn(cwd, args, COMMAND_TIMEOUT_MS);
  if (done.status !== 0) {
    const stderr = Array.from(decode(done.stderr)).slice(0, 200).join('');
    throw new PyError('RuntimeError', `git ${args[0]} failed: ${stderr}`);
  }
  return pyStrip(decode(done.stdout));
}

/** `subprocess.run(['git', ...], check=True, capture_output=True)`: raw bytes. */
function raw(cwd: string, ...args: string[]): Buffer {
  const done = spawn(cwd, args, RAW_TIMEOUT_MS);
  if (done.status !== 0) {
    throw new PyError(
      'CalledProcessError',
      `Command '['git', ${args.map((a) => `'${a}'`).join(', ')}]' returned non-zero exit status ${done.status}.`,
    );
  }
  return done.stdout;
}

/** Python `iter(value)` over a JSON-shaped value. */
function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (typeof value === 'object' && value !== null && !(value instanceof JsonNumber)) {
    return Object.keys(value);
  }
  throw new PyError('TypeError', 'object is not iterable');
}

function distinct(values: readonly unknown[]): number {
  const seen: unknown[] = [];
  for (const value of values) {
    if (
      Array.isArray(value) ||
      (typeof value === 'object' && value !== null && !(value instanceof JsonNumber))
    ) {
      throw new PyError('TypeError', 'unhashable type');
    }
    if (!seen.some((other) => pythonValueEqual(other, value))) seen.push(value);
  }
  return seen.length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * `crq_repair.verify(wt, base, commits, job)`: every claimed commit is a
 * distinct strict descendant of `base`, an ancestor of HEAD, non-empty and
 * names the job; the claimed set is the whole `base..HEAD` range; the tree is
 * clean. Returns HEAD.
 */
export function verifyRepairCommits(
  wt: string,
  base: string,
  commits: unknown,
  job: string,
): string {
  if (!pyTruthy(commits)) throw new PyError('ValueError', 'missing or duplicate claimed commits');
  const claimed = pyIterate(commits);
  if (distinct(claimed) !== claimed.length) {
    throw new PyError('ValueError', 'missing or duplicate claimed commits');
  }
  const head = git(wt, 'rev-parse', 'HEAD');
  const named = new RegExp(`(?<!\\p{Nd})${escapeRegExp(job)}(?!\\p{Nd})`, 'u');
  for (const sha of claimed) {
    if (typeof sha !== 'string') {
      throw new PyError('TypeError', 'expected string or bytes-like object');
    }
    if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
      throw new PyError('ValueError', 'claimed commit is not 40-hex');
    }
    git(wt, 'cat-file', '-e', `${sha}^{commit}`);
    if (sha === base || command(wt, ['merge-base', '--is-ancestor', base, sha]).status !== 0) {
      throw new PyError('ValueError', 'commit is not a strict descendant of base');
    }
    if (command(wt, ['merge-base', '--is-ancestor', sha, head]).status !== 0) {
      throw new PyError('ValueError', 'commit is not an ancestor of HEAD');
    }
    if (!git(wt, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha)) {
      throw new PyError('ValueError', 'empty commit');
    }
    if (!named.test(git(wt, 'show', '-s', '--format=%B', sha))) {
      throw new PyError('ValueError', 'commit message missing finding id');
    }
  }
  const range = new Set(splitlines(git(wt, 'rev-list', `${base}..HEAD`)));
  const wanted = new Set(claimed as string[]);
  if (range.size !== wanted.size || [...range].some((sha) => !wanted.has(sha))) {
    throw new PyError('ValueError', 'unclaimed commits in repair range');
  }
  if (git(wt, 'status', '--porcelain')) throw new PyError('ValueError', 'dirty repair tree');
  return head;
}

const ARCHIVES = [
  'staged.patch',
  'unstaged.patch',
  'committed.patch',
  'untracked.tar',
  'commits.bundle',
] as const;

function untrackedNames(wt: string): string[] {
  const names = raw(wt, 'ls-files', '--others', '--exclude-standard', '-z')
    .toString('latin1')
    .split('\0')
    .filter((name) => name !== '');
  return names.map((latin) => {
    const bytes = Buffer.from(latin, 'latin1');
    try {
      return strictUtf8.decode(bytes);
    } catch {
      throw new PyError('ValueError', 'untracked name is not valid UTF-8');
    }
  });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * `crq_repair.retain.retain(wt, base, directory, include_clean=...)`: capture
 * staged, unstaged, untracked and committed work without changing the tree.
 * Returns the content-addressed snapshot directory, or `null` for a clean tree
 * (unless `includeClean`). A failed or interrupted capture throws before the
 * caller may reset; the half-written capture directory is removed.
 */
export function retain(
  wt: string,
  base: string,
  directory: string,
  options: { readonly includeClean?: boolean } = {},
): string | null {
  const head = git(wt, 'rev-parse', 'HEAD');
  if (command(wt, ['merge-base', '--is-ancestor', base, head]).status !== 0) {
    throw new PyError('ValueError', 'cannot retain worktree with unrelated HEAD');
  }
  const staged = raw(wt, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--');
  const unstaged = raw(wt, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--');
  const committed = raw(wt, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base, head, '--');
  const names = untrackedNames(wt);
  const commits = splitlines(git(wt, 'rev-list', '--reverse', `${base}..${head}`));
  if (
    !options.includeClean &&
    staged.length === 0 &&
    unstaged.length === 0 &&
    names.length === 0 &&
    commits.length === 0
  ) {
    return null;
  }
  mkdirSync(directory, { recursive: true });
  const temp = mkdtempSync(join(directory, '.capture-'));
  try {
    writeFileSync(join(temp, 'staged.patch'), staged);
    writeFileSync(join(temp, 'unstaged.patch'), unstaged);
    writeFileSync(join(temp, 'committed.patch'), committed);
    const bundle = join(temp, 'commits.bundle');
    if (commits.length > 0) raw(wt, 'bundle', 'create', bundle, 'HEAD', `^${base}`);
    else writeFileSync(bundle, Buffer.alloc(0));
    writeFileSync(join(temp, 'untracked.tar'), untrackedTar(wt, names));
    const hashes: Record<string, string> = {};
    for (const name of ARCHIVES) hashes[name] = sha256File(join(temp, name));
    const manifest = { base, head, commits, untracked: names, sha256: hashes };
    const token = receiptJsonDigest(manifest);
    writeFileSync(join(temp, 'manifest.json'), atomicJsonText(manifest), { mode: 0o600 });
    const target = join(directory, `retained-${token}`);
    if (!existsSync(target)) renameSync(temp, target);
    return target;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * `retain.untracked_directories(wt)`: untracked entries git lists as a
 * directory (an unignored nested repository), which `retain` refuses to archive.
 */
export function untrackedDirectories(wt: string): string[] {
  return untrackedNames(wt)
    .map((name) => name.replace(/\/+$/, ''))
    .filter((name) => {
      const path = join(wt, name);
      try {
        return statSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    });
}

function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // `shutil.move` falls back to copy-then-remove across filesystems.
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * `crq_repair.retain_preserving_nested(wt, base, directory)`: `retain`, and
 * when it refuses an unignored nested repository, move each such directory
 * into a fresh `retained-nested/capture-*` holder under `directory` and retry
 * once. Any other refusal, or a refusal with no nested directory, is rethrown.
 */
export function retainPreservingNested(wt: string, base: string, directory: string): void {
  try {
    retain(wt, base, directory);
  } catch (e) {
    if (!isPyError(e, 'UnsupportedUntracked')) throw e;
    const nested = untrackedDirectories(wt);
    if (nested.length === 0) throw e;
    const holder = join(directory, 'retained-nested');
    mkdirSync(holder, { recursive: true });
    const capture = mkdtempSync(join(holder, 'capture-'));
    for (const name of nested) {
      const target = join(capture, name);
      mkdirSync(dirname(target), { recursive: true });
      move(join(wt, name), target);
    }
    retain(wt, base, directory);
  }
}
