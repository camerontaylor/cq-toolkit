// Hardened, no-shell git plumbing for the ratchet verifier (W1.7, ADR-0004).
//
// The verifier judges a subject (a PR head or a pushed commit) whose tree is
// UNTRUSTED: the head controls every file in it, including `.gitattributes`,
// and — on a self-hosted or local run — possibly the repository's own config.
// Every call in this module is therefore built so that nothing the head (or
// ambient state) controls can run code, redirect the read, or reshape output:
//
//   - execFile/spawn with an argv ARRAY; `shell` is never set, so no value is
//     ever re-parsed by a shell.
//   - {@link GIT_HARDEN} prefixes every call (the #221 closed-form design
//     note): `--no-pager` (a configured pager is a program), `--literal-
//     pathspecs` (a pathspec is a path, never `:(glob)`/`:(exclude)` magic),
//     `core.fsmonitor=false` (a configured fsmonitor is a HOOK git would run
//     on any index read), `core.quotePath=true` (one pinned quoting form).
//   - The child env drops every variable that could point git at a different
//     repository, index, object store or config (GIT_DIR, GIT_WORK_TREE,
//     GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_CONFIG_PARAMETERS/COUNT, ...),
//     ignores the system config, never prompts, takes no optional locks, and
//     disables replace refs (a `refs/replace/*` object would make `<rev>`
//     silently read a DIFFERENT tree than its oid names).
//   - Every revision is validated BEFORE spawn: a 40-hex oid or a
//     conservative ref name (effects.ts's SAFE_REF rules). A value starting
//     with `-` can never reach argv as an option; `--end-of-options` (git
//     >= 2.24; this module was verified against 2.39) is placed ahead of
//     revisions as a second, independent barrier.
//   - Diffs carry W1.8's hardened flags ({@link HARDENED_DIFF_FLAGS}): no
//     external diff driver, no textconv (both are repository-configured
//     programs), no rename folding (a rename is reported as delete + add so
//     both sides are judged), fixed a/ b/ prefixes (overrides
//     diff.mnemonicPrefix/diff.noprefix), and additionally no colour and no
//     diff.relative (config that would otherwise reshape the patch text).
//
// Content is read ATTRIBUTE-FREE: `cat-file blob` / `cat-file --batch` apply
// no filters, no textconv, no eol conversion and no export-subst, so the bytes
// are exactly the committed blob. The tree is extracted with `ls-tree` +
// `cat-file --batch` — NEVER `git archive` (honours the head's
// export-ignore/export-subst, ADR-0004 R2-2) and never a checkout (runs smudge
// filters and hooks).
//
// Every fault THROWS an Error prefixed `ratchet git:` — callers fold it into
// `failed`/`needs-human`, never a fabricated reading.
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Global options prefixed to every git invocation (#221 closed-form hardening). */
export const GIT_HARDEN: readonly string[] = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=true',
];

/**
 * Diff flags for every diff this module runs: W1.8's hardened set (text, no
 * external driver, no textconv, no renames, pinned prefixes) plus `--no-color`
 * and `--no-relative`, which pin repository config (`color.diff=always`,
 * `diff.relative=true`) that would otherwise reshape the patch text a parser
 * consumes.
 */
export const HARDENED_DIFF_FLAGS: readonly string[] = [
  '--text',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-color',
  '--no-relative',
];

/** Captured output ceiling for text-returning calls (a full diff or a blob). */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Ceiling on the TOTAL bytes a tree extraction may stream (a hostile head could add huge blobs). */
const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024;

/** Wall-clock cap per subprocess; exceeded → SIGKILL → thrown. */
const EXEC_TIMEOUT_MS = 120_000;

/**
 * Ambient variables that could redirect git to a different repository,
 * index, object store, namespace or configuration — or run a program. All
 * are deleted from the child env so `-C <repo>` alone decides what is read.
 */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_REPLACE_REF_BASE',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

/** The hardened child env: inherited, minus redirections, plus the pinned switches. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  return env;
}

const OID = /^[0-9a-f]{40}$/;

/** effects.ts's SAFE_REF: no leading `-`, no control/space/glob/`:`/`^`/`~` characters. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Validate a revision BEFORE it can reach argv: a 40-hex oid, or a
 * conservative ref name. Rejects anything option-shaped (`--output=...`),
 * any revision-syntax operator (`..`, `@{`, `^`, `~`, `:`), and git's
 * forbidden ref endings.
 */
function assertRev(rev: string, label: string): void {
  if (OID.test(rev)) return;
  if (
    rev === '' ||
    !SAFE_REF.test(rev) ||
    rev.endsWith('/') ||
    rev.endsWith('.') ||
    rev.endsWith('.lock') ||
    rev.includes('..') ||
    rev.includes('//') ||
    rev.includes('@{')
  ) {
    throw new Error(`ratchet git: refusing unsafe ${label} revision '${rev}'`);
  }
}

/** A `.git` path segment, including the forms some filesystems fold onto it (`.git.`, `.git `). */
const DOT_GIT_SEGMENT = /^\.git[. ]*$/i;

/**
 * Validate a repository-relative POSIX path: non-empty, not absolute, no
 * empty/`.`/`..` segment, no `.git` segment, no backslash (a separator on
 * Windows), no NUL/control character, no leading `:` (pathspec/rev magic).
 * Used for both caller-supplied read paths and every path a tree listing
 * yields before it is joined under an extraction root.
 */
export function assertRepoRelPath(path: string, label = 'path'): void {
  const bad = (why: string): never => {
    throw new Error(`ratchet git: refusing ${label} '${path}' (${why})`);
  };
  if (path === '') bad('empty');
  if (path.startsWith('/')) bad('absolute');
  if (path.startsWith(':')) bad('leading colon');
  if (path.includes('\\')) bad('backslash');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(path)) bad('control character');
  for (const segment of path.split('/')) {
    if (segment === '') bad('empty segment');
    if (segment === '.' || segment === '..') bad('dot segment');
    if (DOT_GIT_SEGMENT.test(segment)) bad('.git segment');
  }
}

interface RawResult {
  ok: boolean;
  timedOut: boolean;
  /** The child's numeric exit code, or null when it did not exit normally (signal, spawn error). */
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** One hardened git call, never rejecting: the caller decides what a non-zero exit means. */
function execGit(repo: string, args: readonly string[]): Promise<RawResult> {
  return execGitWithEnv(repo, args, gitEnv());
}

/**
 * {@link execGit} with an explicit child env. Private: the only caller that
 * passes anything but {@link gitEnv} is {@link gitPushAtomic}, whose env is
 * gitEnv() plus the step-scoped credential header.
 */
function execGitWithEnv(
  repo: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RawResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repo, ...GIT_HARDEN, ...args],
      {
        env,
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        timeout: EXEC_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && (error as { killed?: unknown }).killed === true;
        const rawCode = error === null ? 0 : (error as { code?: unknown }).code;
        resolve({
          ok: error === null,
          timedOut,
          code: typeof rawCode === 'number' ? rawCode : null,
          stdout,
          stderr: stderr.toString('utf8'),
        });
      },
    );
  });
}

/** One hardened git call that must succeed; returns raw stdout. */
async function runGit(repo: string, args: readonly string[]): Promise<Buffer> {
  const res = await execGit(repo, args);
  const name = args[0] ?? '';
  if (res.timedOut) throw new Error(`ratchet git: ${name} timed out after ${EXEC_TIMEOUT_MS}ms`);
  if (!res.ok) {
    throw new Error(
      `ratchet git: ${name} failed: ${res.stderr.trim() || res.stdout.toString('utf8').trim()}`,
    );
  }
  return res.stdout;
}

/** Strict UTF-8 decode: a non-UTF-8 path would otherwise be silently rewritten to U+FFFD. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Parse a single 40-hex oid line (rev-parse / merge-base output). */
function oneOid(out: Buffer, what: string): string {
  const oid = out.toString('utf8').trim();
  if (!OID.test(oid)) throw new Error(`ratchet git: ${what} returned no commit oid ('${oid}')`);
  return oid;
}

/** Resolve `rev` to its 40-hex COMMIT oid (`rev-parse --verify <rev>^{commit}`). */
export async function gitRevParse(repo: string, rev: string): Promise<string> {
  assertRev(rev, 'rev-parse');
  const out = await runGit(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]);
  return oneOid(out, `rev-parse ${rev}`);
}

/** The merge-base commit of `a` and `b`. */
export async function gitMergeBase(repo: string, a: string, b: string): Promise<string> {
  assertRev(a, 'merge-base');
  assertRev(b, 'merge-base');
  const out = await runGit(repo, ['merge-base', '--end-of-options', a, b]);
  return oneOid(out, `merge-base ${a} ${b}`);
}

/** One `ls-tree` record. */
interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** Parse `ls-tree -z` output: `<mode> SP <type> SP <oid> TAB <path> NUL` records. */
function parseLsTree(out: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0, start);
    if (end === -1) end = out.length;
    const record = out.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new Error('ratchet git: malformed ls-tree record (no TAB)');
    const meta = record.subarray(0, tab).toString('utf8').split(' ');
    let path: string;
    try {
      path = STRICT_UTF8.decode(record.subarray(tab + 1));
    } catch {
      throw new Error('ratchet git: ls-tree yielded a non-UTF-8 path');
    }
    const [mode, type, oid] = meta;
    if (meta.length !== 3 || mode === undefined || type === undefined || oid === undefined) {
      throw new Error(`ratchet git: malformed ls-tree record '${meta.join(' ')}'`);
    }
    if (!OID.test(oid)) throw new Error(`ratchet git: malformed ls-tree oid '${oid}'`);
    entries.push({ mode, type, oid, path });
  }
  return entries;
}

/** Regular-file blob modes; everything else (symlink 120000, gitlink 160000) is not file content. */
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

/**
 * The content of `path` at `rev`, exactly as committed (utf8-decoded; no
 * attributes, filters or textconv apply to `cat-file blob`), or null when the
 * path is absent at `rev`. Absence is decided by an exact-path `ls-tree`
 * lookup that also resolves the revision, so a bad revision throws rather
 * than reading as "absent". A path that names a tree, a symlink or a gitlink
 * throws: none is file content, and following a symlink would read a target
 * the head chose.
 */
export async function gitReadBlob(repo: string, rev: string, path: string): Promise<string | null> {
  assertRepoRelPath(path);
  assertRev(rev, 'read');
  // `<rev>^{commit}` makes ls-tree itself resolve the revision: an unknown
  // revision exits non-zero (throws), while an absent path exits 0 with an
  // empty listing — one spawn separates "absent" from "bad revision".
  const listing = await runGit(repo, [
    'ls-tree',
    '-z',
    '--full-tree',
    '--end-of-options',
    `${rev}^{commit}`,
    '--',
    path,
  ]);
  const entry = parseLsTree(listing).find((candidate) => candidate.path === path);
  if (entry === undefined) return null;
  if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
    throw new Error(
      `ratchet git: '${path}' at ${rev} is not a regular file (mode ${entry.mode} ${entry.type})`,
    );
  }
  const out = await runGit(repo, ['cat-file', 'blob', entry.oid]);
  return out.toString('utf8');
}

/**
 * Every REGULAR-blob path (100644/100755) at or under the repo-relative
 * directory `prefix` at `rev`, sorted (W1.9: the policy diff enumerates
 * `.github/workflows` at both ends of the judged range). Built like
 * {@link gitReadBlob}: `ls-tree -r -z --full-tree` with the revision resolved
 * as `<rev>^{commit}` (a bad revision throws, an absent prefix lists
 * nothing) and the prefix placed after `--` under `--literal-pathspecs`.
 * Symlinks, gitlinks and trees are not file content and are omitted; every
 * listed path is validated with {@link assertRepoRelPath}, so a hostile tree
 * entry throws rather than reaching a caller.
 */
export async function gitListPaths(repo: string, rev: string, prefix: string): Promise<string[]> {
  assertRepoRelPath(prefix, 'list prefix');
  assertRev(rev, 'list');
  const listing = await runGit(repo, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    '--end-of-options',
    `${rev}^{commit}`,
    '--',
    prefix,
  ]);
  const paths: string[] = [];
  for (const entry of parseLsTree(listing)) {
    // ls-tree prefix-matches path components; keep exactly the directory's contents.
    if (!entry.path.startsWith(`${prefix}/`)) continue;
    assertRepoRelPath(entry.path, 'tree path');
    if (entry.type === 'blob' && REGULAR_BLOB_MODES.has(entry.mode)) paths.push(entry.path);
  }
  return paths.sort();
}

/** Split `-z` name output into paths (empty trailing record dropped). */
function splitNul(out: Buffer): string[] {
  const text = out.toString('utf8');
  return text.split('\0').filter((path) => path !== '');
}

/**
 * Every path that differs between `from` and `to` (commit-to-commit; the
 * index and working tree are never consulted). Renames are off, so a rename
 * is reported as its deleted source AND its added destination.
 */
export async function gitChangedPaths(repo: string, from: string, to: string): Promise<string[]> {
  assertRev(from, 'diff from');
  assertRev(to, 'diff to');
  const out = await runGit(repo, [
    'diff',
    ...HARDENED_DIFF_FLAGS,
    '--name-only',
    '-z',
    '--end-of-options',
    from,
    to,
    '--',
  ]);
  return splitNul(out);
}

/**
 * The full unified patch `from`..`to`, restricted to `pathspecs` (LITERAL
 * paths — --literal-pathspecs disables magic — placed after `--`, so none can
 * be read as an option). An empty list diffs the whole tree.
 */
export async function gitDiffText(
  repo: string,
  from: string,
  to: string,
  pathspecs: readonly string[],
): Promise<string> {
  assertRev(from, 'diff from');
  assertRev(to, 'diff to');
  for (const spec of pathspecs) {
    if (spec === '' || spec.includes('\0')) {
      throw new Error(`ratchet git: refusing empty or NUL-bearing pathspec`);
    }
  }
  const out = await runGit(repo, [
    'diff',
    ...HARDENED_DIFF_FLAGS,
    '--end-of-options',
    from,
    to,
    '--',
    ...pathspecs,
  ]);
  return out.toString('utf8');
}

/** Stream a list of blob oids through ONE `cat-file --batch`; returns contents in request order. */
function catFileBatch(repo: string, oids: readonly string[]): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...GIT_HARDEN, 'cat-file', '--batch'], {
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let failure: Error | null = null;
    const fail = (err: Error): void => {
      if (failure === null) failure = err;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      fail(new Error(`ratchet git: cat-file --batch timed out after ${EXEC_TIMEOUT_MS}ms`));
    }, EXEC_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_EXTRACT_BYTES) {
        fail(new Error(`ratchet git: tree content exceeds ${MAX_EXTRACT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // EPIPE on an early child exit surfaces through 'close' below.
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      fail(new Error(`ratchet git: cat-file --batch spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure !== null) return reject(failure);
      if (code !== 0) {
        return reject(new Error(`ratchet git: cat-file --batch failed: ${stderr.trim()}`));
      }
      try {
        resolve(parseBatch(Buffer.concat(chunks), oids));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stdin.end(oids.map((oid) => `${oid}\n`).join(''));
  });
}

/**
 * Parse `cat-file --batch` framing — `<oid> blob <size>\n<bytes>\n` per
 * request — from a Buffer, so binary content is sliced by the declared size
 * and never re-decoded. Each response must answer the oid requested at its
 * position; a `missing` response or a non-blob throws.
 */
function parseBatch(out: Buffer, oids: readonly string[]): Buffer[] {
  const contents: Buffer[] = [];
  let pos = 0;
  for (const oid of oids) {
    const nl = out.indexOf(0x0a, pos);
    if (nl === -1) throw new Error('ratchet git: truncated cat-file --batch header');
    const header = out.subarray(pos, nl).toString('utf8');
    const match = /^([0-9a-f]{40}) (\S+) (\d+)$/.exec(header);
    if (match === null || match[1] !== oid || match[2] !== 'blob') {
      throw new Error(`ratchet git: unexpected cat-file --batch header '${header}' for ${oid}`);
    }
    const size = Number(match[3]);
    const start = nl + 1;
    const end = start + size;
    if (end + 1 > out.length || out[end] !== 0x0a) {
      throw new Error(`ratchet git: truncated cat-file --batch body for ${oid}`);
    }
    contents.push(out.subarray(start, end));
    pos = end + 1;
  }
  if (pos !== out.length) throw new Error('ratchet git: trailing cat-file --batch output');
  return contents;
}

/** A tree entry deliberately NOT extracted. */
export interface SkippedEntry {
  path: string;
  mode: string;
}

/** What {@link extractTreeAttributeFree} wrote. */
export interface ExtractResult {
  files: number;
  skipped: SkippedEntry[];
}

/** `dest` must be absent (created) or an empty real directory (not a symlink). */
async function prepareDest(dest: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(dest, { recursive: true });
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`ratchet git: extraction target '${dest}' exists and is not a directory`);
  }
  if ((await readdir(dest)).length !== 0) {
    throw new Error(`ratchet git: extraction target '${dest}' is not empty`);
  }
}

/**
 * Materialize the tree of `rev` under `dest`, ATTRIBUTE-FREE: `ls-tree -r -z
 * --full-tree` enumerates it, ONE `cat-file --batch` streams the regular
 * blobs (100644/100755), and each is written byte-identical with mode 0o644
 * (the trusted tool only reads the tree, so the exec bit is irrelevant).
 *
 * Never `git archive` (it honours the head's export-ignore/export-subst,
 * ADR-0004 R2-2) and never a checkout (smudge filters, hooks, eol
 * conversion). Symlinks (120000) are SKIPPED and recorded — a head symlink
 * could point the trusted `tsc` at runner paths — as are gitlinks (160000).
 * Any path that is absolute or carries an empty/`.`/`..`/`.git` segment is
 * REFUSED (throws) before anything is written, and files are created with
 * `wx` so a duplicate or case-folded collision throws instead of silently
 * overwriting an earlier file. A tracked `node_modules` segment is also
 * refused: otherwise tsc could resolve head-controlled declarations before
 * the trust checkout's dependencies. `dest` must not exist or be empty.
 */
export async function extractTreeAttributeFree(
  repo: string,
  rev: string,
  dest: string,
): Promise<ExtractResult> {
  const commit = await gitRevParse(repo, rev);
  const entries = parseLsTree(
    await runGit(repo, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', commit]),
  );
  const blobs: TreeEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const entry of entries) {
    assertRepoRelPath(entry.path, 'tree path');
    if (entry.path.split('/').includes('node_modules')) {
      throw new Error(`ratchet git: refusing head-controlled node_modules path '${entry.path}'`);
    }
    if (entry.type === 'blob' && REGULAR_BLOB_MODES.has(entry.mode)) blobs.push(entry);
    else if (entry.mode === '120000' || entry.mode === '160000') {
      skipped.push({ path: entry.path, mode: entry.mode });
    } else {
      throw new Error(
        `ratchet git: unexpected tree entry '${entry.path}' (mode ${entry.mode} ${entry.type})`,
      );
    }
  }
  await prepareDest(dest);
  const contents =
    blobs.length === 0
      ? []
      : await catFileBatch(
          repo,
          blobs.map((b) => b.oid),
        );
  for (const [index, entry] of blobs.entries()) {
    const content = contents[index];
    if (content === undefined) throw new Error(`ratchet git: no content for '${entry.path}'`);
    const target = join(dest, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644, flag: 'wx' });
  }
  return { files: blobs.length, skipped };
}

// ---------------------------------------------------------------------------
// Commit-graph reads and the atomic push (W1.10, the promotion gate — ADR-0004
// D-K, methods note Decision 13). Same closed form as everything above:
// argv arrays, GIT_HARDEN, the scrubbed env, revisions validated before
// spawn, `--end-of-options` ahead of every revision. The gate reads the
// queue tip only as git objects; nothing here checks out or runs its code.
// ---------------------------------------------------------------------------

/** Refuse anything but a 40-hex oid (the `^<oid>` exclusion form takes no ref names). */
function assertOid(rev: string, label: string): void {
  if (!OID.test(rev)) throw new Error(`ratchet git: ${label} must be a 40-hex oid, got '${rev}'`);
}

/** Parse newline-separated rev-list output lines into oid rows (each token validated). */
function oidLines(out: Buffer, what: string): string[][] {
  const rows: string[][] = [];
  for (const line of out.toString('utf8').split('\n')) {
    if (line === '') continue;
    const tokens = line.split(' ');
    for (const token of tokens) {
      if (!OID.test(token))
        throw new Error(`ratchet git: ${what} yielded a malformed oid '${token}'`);
    }
    rows.push(tokens);
  }
  return rows;
}

/**
 * Whether `a` is an ancestor of (or equal to) `b` (`merge-base
 * --is-ancestor`). Exit 1 is the answer "no"; any other failure (an unknown
 * revision exits 128) throws.
 */
export async function gitIsAncestor(repo: string, a: string, b: string): Promise<boolean> {
  assertRev(a, 'is-ancestor');
  assertRev(b, 'is-ancestor');
  const res = await execGit(repo, ['merge-base', '--is-ancestor', '--end-of-options', a, b]);
  if (res.ok) return true;
  if (res.timedOut) {
    throw new Error(`ratchet git: merge-base --is-ancestor timed out after ${EXEC_TIMEOUT_MS}ms`);
  }
  if (res.code === 1) return false;
  throw new Error(
    `ratchet git: merge-base --is-ancestor failed: ${res.stderr.trim() || `exit ${String(res.code)}`}`,
  );
}

/** One commit of a range with its parents, in rev-list order. */
export interface RangeCommit {
  sha: string;
  parents: string[];
}

/**
 * Every commit in `from..to` (reachable from `to`, not from `from`) with its
 * parents, topologically ordered (`rev-list --parents --topo-order`). Both
 * ends must be 40-hex oids: the exclusion is spelled `^<from>`, which only an
 * oid can safely carry.
 */
export async function gitRangeCommits(
  repo: string,
  from: string,
  to: string,
): Promise<RangeCommit[]> {
  assertOid(from, 'range from');
  assertOid(to, 'range to');
  const out = await runGit(repo, [
    'rev-list',
    '--parents',
    '--topo-order',
    '--end-of-options',
    to,
    `^${from}`,
  ]);
  return oidLines(out, 'rev-list --parents').map(([sha = '', ...parents]) => ({ sha, parents }));
}

/**
 * The first-parent chain of `to`, newest first, down to (excluding) the first
 * commit reachable from `from` (`rev-list --first-parent <to> ^<from>`).
 * Both ends must be 40-hex oids.
 */
export async function gitFirstParentRange(
  repo: string,
  from: string,
  to: string,
): Promise<string[]> {
  assertOid(from, 'first-parent from');
  assertOid(to, 'first-parent to');
  const out = await runGit(repo, [
    'rev-list',
    '--first-parent',
    '--end-of-options',
    to,
    `^${from}`,
  ]);
  return oidLines(out, 'rev-list --first-parent').map((row) => {
    if (row.length !== 1 || row[0] === undefined) {
      throw new Error('ratchet git: rev-list --first-parent yielded a malformed line');
    }
    return row[0];
  });
}

/** The 40-hex TREE oid of commit `commit` (`rev-parse --verify <commit>^{commit}^{tree}`). */
export async function gitTreeOf(repo: string, commit: string): Promise<string> {
  assertRev(commit, 'tree-of');
  const out = await runGit(repo, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${commit}^{commit}^{tree}`,
  ]);
  const oid = out.toString('utf8').trim();
  if (!OID.test(oid)) throw new Error(`ratchet git: tree of ${commit} is not an oid ('${oid}')`);
  return oid;
}

/**
 * The tree a clean merge of `p1` and `p2` produces (`merge-tree --write-tree
 * --no-messages`, the ort strategy; git >= 2.38), or null when the merge
 * conflicts (exit 1 with a tree oid on stdout — exit 1 WITHOUT one is an
 * unknown revision, which throws). Writes only loose tree/blob objects — no ref, index or
 * working-tree change. Anything else throws, including an older git that
 * lacks `--write-tree`: that version skew surfaces as a gate refusal (a false
 * refusal, never a false pass — fail closed). Nothing beyond git's defaults
 * is pinned, so the result is what the forge's own ort merge would produce.
 */
export async function gitMergeTreeClean(
  repo: string,
  p1: string,
  p2: string,
): Promise<string | null> {
  assertRev(p1, 'merge-tree');
  assertRev(p2, 'merge-tree');
  const res = await execGit(repo, [
    'merge-tree',
    '--write-tree',
    '--no-messages',
    '--end-of-options',
    p1,
    p2,
  ]);
  if (res.timedOut) throw new Error(`ratchet git: merge-tree timed out after ${EXEC_TIMEOUT_MS}ms`);
  // Exit 1 is shared by "conflicted" and "cannot merge that" (an unknown
  // revision): only a conflict prints the (conflicted) tree oid first.
  const first = res.stdout.toString('utf8').split('\n', 1)[0] ?? '';
  if (!(res.ok || res.code === 1) || !OID.test(first)) {
    throw new Error(
      `ratchet git: merge-tree failed: ${res.stderr.trim() || `exit ${String(res.code)}`}`,
    );
  }
  return res.ok ? first : null;
}

/** The only remote URL shapes a push may target: an https GitHub-style repo URL. */
const PUSH_HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;

/** A push refspec: an exact oid onto a branch — never a `+` force, never a pattern. */
const PUSH_REFSPEC = /^([0-9a-f]{40}):refs\/heads\/(.+)$/;

/** Validate the push target: an https repo URL, or an absolute local path / `file:///` URL. */
function assertPushUrl(url: string): void {
  if (PUSH_HTTPS_URL.test(url)) return;
  const local = url.startsWith('file:///') ? url.slice('file://'.length) : url;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  const safeLocal = local.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(local);
  if (!safeLocal) throw new Error(`ratchet git: refusing push url '${url}'`);
}

/**
 * Atomically push `refspecs` (each `<40-hex>:refs/heads/<branch>`) to `url`:
 * `push --atomic --porcelain --no-verify`, NEVER forced — the server's
 * non-fast-forward refusal is the compare-and-swap, and `--atomic` makes one
 * refusal refuse every ref. A rejection or transport failure RESOLVES
 * `{ ok: false, output }` (porcelain stdout + stderr); only invalid input
 * throws, before anything is spawned.
 *
 * The credential travels ONLY through the child env, as a step-scoped
 * `GIT_CONFIG_*` extra-header for `<scheme>://<host>/` — never argv (visible
 * in the process table), never `.git/config` (persisted). The same env
 * resets any configured extra-header for that host (actions/checkout's
 * persisted credential would otherwise ride along), empties
 * `credential.helper` and `core.askPass` (both are programs) and drops
 * GIT_ASKPASS/SSH_ASKPASS, so no program is asked for a secret. A local
 * path or `file:///` URL (tests push to a local bare repo) carries no
 * header. The token (and its encoded form) is redacted from the output.
 */
export async function gitPushAtomic(
  repo: string,
  url: string,
  refspecs: readonly string[],
  token: string,
): Promise<{ ok: boolean; output: string }> {
  assertPushUrl(url);
  if (refspecs.length === 0) throw new Error('ratchet git: refusing an empty push');
  for (const spec of refspecs) {
    const match = PUSH_REFSPEC.exec(spec);
    const branch = match?.[2];
    if (branch === undefined) throw new Error(`ratchet git: refusing push refspec '${spec}'`);
    assertRev(branch, 'push branch');
  }
  const env = gitEnv();
  delete env['GIT_ASKPASS'];
  delete env['SSH_ASKPASS'];
  const config: [string, string][] = [
    ['credential.helper', ''],
    ['core.askPass', ''],
  ];
  const secrets: string[] = [];
  if (url.startsWith('https://')) {
    if (token === '' || /[\r\n]/.test(token)) {
      throw new Error('ratchet git: refusing an empty or multi-line push credential');
    }
    const origin = new URL(url).origin;
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    secrets.push(token, basic);
    config.push(
      [`http.${origin}/.extraheader`, ''],
      [`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
    );
  }
  env['GIT_CONFIG_COUNT'] = String(config.length);
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  }
  const res = await execGitWithEnv(
    repo,
    ['push', '--atomic', '--porcelain', '--no-verify', '--end-of-options', url, ...refspecs],
    env,
  );
  let output = `${res.stdout.toString('utf8')}${res.stderr}`.trim();
  if (res.timedOut) output = `${output}\npush timed out after ${EXEC_TIMEOUT_MS}ms`.trim();
  for (const secret of secrets) output = output.split(secret).join('***');
  return { ok: res.ok, output };
}
