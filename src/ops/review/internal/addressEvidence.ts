import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath, mkdir, open, writeFile, unlink, readdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { GIT_HARDEN, HARDENED_DIFF_FLAGS } from '../../../shared/gitHarden.js';
import {
  validateAddressTerminalAuthority,
  trackAddressTerminalProcess,
} from './addressOwnership.js';
import {
  commitFailedAttempt,
  type FailedAttempt,
  type FailedAttemptInput,
  type FailedAttemptGate,
} from '../../sweep/taskLoop.js';
import type { ModelSpec } from '../../../driver/types.js';
import { SWEEP_DIFF_FLAGS } from '../../../shared/gitDiffFlags.js';

export interface AddressFailedAttempt extends FailedAttempt {
  finding: string;
  unit: string;
  outcome: 'unfixed' | 'escalated-to-human';
  model: ModelSpec;
  file: string;
  parent: string;
  executionHead: string;
  ordinal: number;
  tier: 'worker' | 'rescue';
  gate: FailedAttemptGate;
  reason: string;
}

/** Reuse the settled commit convention only against an isolated owned index. */
export async function pinAddressFailure(
  git: (args: string[]) => Promise<string>,
  input: FailedAttemptInput,
): Promise<FailedAttempt> {
  let creations = 0;
  return commitFailedAttempt(async (args) => {
    // The general helper retries occupied ordinals; S6 bounds that work even
    // when cleanup is running after cancellation or budget exhaustion.
    if (creations >= 32) throw new Error('failed-attempt branch collision limit exhausted');
    if (args[0] === 'update-ref') creations++;
    return git(args);
  }, input).catch((error: unknown) => {
    if (creations >= 32)
      throw new Error('failed-attempt branch collision limit exhausted', { cause: error });
    throw error;
  });
}

/** Reconstruct feedback from immutable engine-owned coordinates, never a ref tip. */
export async function addressFailureFeedback(
  git: (args: string[]) => Promise<string>,
  prior: AddressFailedAttempt,
): Promise<{ patch: string; contents: Array<{ text: string; path: string }> }> {
  if ((await git(['rev-parse', '--verify', `refs/heads/${prior.branch}`])) !== prior.sha)
    throw new Error('prior failed-attempt branch no longer matches its recorded ordinal');
  if (
    (await git(['rev-list', '--parents', '-n', '1', prior.sha])) !== `${prior.sha} ${prior.parent}`
  )
    throw new Error('prior failed-attempt parentage changed');
  const paths = (
    await git(['diff', ...SWEEP_DIFF_FLAGS, '--name-only', '-z', prior.parent, prior.sha, '--'])
  )
    .split('\0')
    .filter(Boolean);
  if (paths.some((path) => path !== prior.file))
    throw new Error('prior failed-attempt contains an unowned path');
  const contents: Array<{ text: string; path: string }> = [];
  for (const revision of [prior.parent, prior.sha]) {
    const object = `${revision}:${prior.file}`;
    const size = await git(['cat-file', '-s', object]);
    if (!/^\d+$/.test(size) || Number(size) > 4 * 1024 * 1024)
      throw new Error('prior failed-attempt file exceeds feedback cap');
    const text = await git(['show', object]);
    if (text.includes('\0') || text.includes('\uFFFD') || Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new Error('prior failed-attempt file is not safely scannable text');
    contents.push({ text, path: prior.file });
  }
  const message = await git(['show', '-s', '--format=%B', prior.sha]);
  if (Buffer.byteLength(message) > 4 * 1024 * 1024)
    throw new Error('prior failed-attempt provenance exceeds feedback cap');
  contents.push({ text: message, path: '.git/cq-failed-commit-message' });
  contents.push({ text: JSON.stringify(prior), path: 'cq-failed-attempt.json' });
  const patch = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--binary',
    '--full-index',
    prior.parent,
    prior.sha,
    '--',
  ]);
  if (Buffer.byteLength(patch) > 32 * 1024 * 1024)
    throw new Error('prior failed-attempt patch exceeds feedback cap');
  return { patch, contents };
}

// Terminal IO is reachable only with a private owner token. No op/dependency
// receives this token, a raw runner or an executable cleanup callback.
const SOURCE_CAP = 4 * 1024 * 1024;
const TOTAL_CAP = 32 * 1024 * 1024;
const OUTPUT_CAP = 8 * 1024 * 1024;
const ERROR_CAP = 64 * 1024;
const REPORT_CAP = 16 * 1024 * 1024;
interface TerminalSession {
  bin: string;
  binary: { dev: number; ino: number };
  directoryIdentity: { dev: number; ino: number };
  hooksIdentity: { dev: number; ino: number };
  configIdentity: { dev: number; ino: number };
  indexIdentity?: { dev: number; ino: number };
  common: string;
  checkouts: Map<
    string,
    {
      gitDir: string;
      directory: { dev: number; ino: number };
      entry: { dev: number; ino: number };
      link?: string;
    }
  >;
  directory: string;
  config: string;
  hooks: string;
  index: string;
  bytes: number;
  records: number;
  verifiedHeads?: Map<string, Set<string>>;
  bookkeeping?: Map<string, string>;
}
const terminalSessions = new WeakMap<object, Promise<TerminalSession>>();
export interface AddressTerminalAttemptInput {
  root: string;
  file: string;
  parent: string;
  executionHead: string;
  runPrefix: string;
  finding: string;
  slug: string;
  ordinal: number;
  tier: 'worker' | 'rescue';
  model: ModelSpec;
}
export interface AddressTerminalAttempt extends AddressTerminalAttemptInput {
  baseline: Buffer;
  gitDir: string;
  branch: string;
  mode: string;
  blob: string;
  pathIdentity: { dev: number; ino: number; mode: number };
  cancelled: boolean;
  retained?: AddressFailedAttempt;
}
const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

async function boundedBytes(path: string, cap: number): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap)
      throw new Error('terminal file identity/size refused');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('terminal file shortened');
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const after = await fd.stat(),
      named = await lstat(path);
    if (
      (await fd.read(extra, 0, 1, offset)).bytesRead ||
      !sameFile(stat, named) ||
      !sameFile(stat, after) ||
      after.size !== stat.size ||
      named.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('terminal file changed while reading');
    return bytes;
  } finally {
    await fd.close();
  }
}

async function validateEvidenceAuthority(token: object, terminal: boolean) {
  const context = await validateAddressTerminalAuthority(token);
  if (context.terminal !== terminal) throw new Error('terminal evidence phase refused');
  return context;
}

async function terminalSession(
  token: object,
  root: string,
  terminal = false,
  allowStopping = false,
): Promise<TerminalSession> {
  const validate = () =>
    allowStopping
      ? validateAddressTerminalAuthority(token)
      : validateEvidenceAuthority(token, terminal);
  await validate();
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    throw new Error('terminal required no-follow/directory IO unsupported');
  let pending = terminalSessions.get(token);
  if (!pending) {
    pending = (async () => {
      const context = await validate();
      const canonical = await realpath(root);
      let bin: string | undefined;
      for (const path of (process.env.PATH ?? '').split(delimiter)) {
        if (!path || !isAbsolute(path)) continue;
        try {
          const candidate = await realpath(join(path, 'git'));
          if (!relative(canonical, candidate).startsWith('..')) continue;
          await access(candidate, constants.X_OK);
          const stat = await lstat(candidate);
          if (stat.isFile()) {
            bin = candidate;
            break;
          }
        } catch {
          /* A missing search entry grants nothing. */
        }
      }
      if (!bin) throw new Error('terminal trusted Git executable unavailable');
      const binary = await lstat(bin);
      const directory = join(context.commonDir, `cq-address-terminal-${randomUUID()}`);
      await validate();
      await mkdir(directory, { mode: 0o700 });
      const config = join(directory, 'empty-config');
      const hooks = join(directory, 'empty-hooks');
      await validate();
      await mkdir(hooks, { mode: 0o700 });
      await validate();
      await writeFile(config, '', { flag: 'wx', mode: 0o600 });
      return {
        bin,
        binary,
        directoryIdentity: await lstat(directory),
        hooksIdentity: await lstat(hooks),
        configIdentity: await lstat(config),
        common: context.commonDir,
        checkouts: new Map(),
        directory,
        config,
        hooks,
        index: join(directory, 'index'),
        bytes: 0,
        records: 0,
      };
    })();
    terminalSessions.set(token, pending);
  }
  return pending;
}

// This is a private implementation, not a caller command allowlist. All argv
// below are constructed by fixed evidence operations in this module.
async function terminalGit(
  token: object,
  session: TerminalSession,
  root: string,
  args: string[],
  options: {
    cleanup?: boolean;
    input?: Buffer;
    index?: string;
    count?: { launches: number; deadline: number };
  } = {},
): Promise<Buffer> {
  await (options.cleanup
    ? validateAddressTerminalAuthority(token)
    : validateEvidenceAuthority(token, options.count !== undefined));
  if (!sameFile(await lstat(session.bin), session.binary))
    throw new Error('terminal Git binary changed');
  for (const [path, identity] of [
    [session.directory, session.directoryIdentity],
    [session.hooks, session.hooksIdentity],
    [session.config, session.configIdentity],
  ] as const) {
    if (!sameFile(await lstat(path), identity) || (await realpath(path)) !== path)
      throw new Error('terminal environment identity changed');
  }
  if ((await boundedBytes(session.config, 0)).length || (await readdir(session.hooks)).length)
    throw new Error('terminal environment contents changed');
  if (options.index === session.index) {
    let current: { dev: number; ino: number } | undefined;
    try {
      current = await lstat(session.index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current && (!session.indexIdentity || !sameFile(current, session.indexIdentity)))
      throw new Error('terminal private index replaced');
    if (!current && session.indexIdentity) throw new Error('terminal private index missing');
  }
  const count = options.count;
  if (count && (++count.launches > 512 || Date.now() >= count.deadline))
    throw new Error('terminal command/time bound reached');
  if ((options.input?.length ?? 0) > SOURCE_CAP) throw new Error('terminal stdin bound reached');
  const cwd = await realpath(root);
  const checkout = session.checkouts.get(cwd);
  if (checkout) {
    const entry = join(cwd, '.git');
    if (
      !sameFile(await lstat(checkout.gitDir), checkout.directory) ||
      !sameFile(await lstat(entry), checkout.entry) ||
      (checkout.link !== undefined &&
        digestBytes(await boundedBytes(entry, 4096)) !== checkout.link)
    )
      throw new Error('terminal checkout/git-dir identity changed');
  }
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(session.bin),
    HOME: session.directory,
    XDG_CONFIG_HOME: session.directory,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: session.config,
    GIT_CONFIG_GLOBAL: session.config,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    ...(checkout
      ? { GIT_DIR: checkout.gitDir, GIT_WORK_TREE: cwd, GIT_COMMON_DIR: session.common }
      : {}),
    GIT_AUTHOR_NAME: 'CQ fix engine',
    GIT_AUTHOR_EMAIL: 'cq-fix-engine@invalid',
    GIT_COMMITTER_NAME: 'CQ fix engine',
    GIT_COMMITTER_EMAIL: 'cq-fix-engine@invalid',
    ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
  };
  const overrides = [
    'core.hooksPath=' + session.hooks,
    'core.attributesFile=' + session.config,
    'core.untrackedCache=false',
    'credential.helper=',
    'core.askPass=',
    'gc.auto=0',
    'maintenance.auto=false',
    'protocol.allow=never',
    'commit.gpgSign=false',
    'tag.gpgSign=false',
  ];
  let resolveProcess!: () => void;
  const settled = new Promise<void>((done) => {
    resolveProcess = done;
  });
  await (options.cleanup
    ? validateAddressTerminalAuthority(token)
    : validateEvidenceAuthority(token, options.count !== undefined));
  trackAddressTerminalProcess(token, settled);
  const output = await new Promise<Buffer>((done, reject) => {
    let child: ReturnType<typeof spawn>;
    let spawned = false;
    let fault: Error | undefined;
    let killRequested = false;
    let stdoutBytes = 0,
      stderrBytes = 0;
    const stdout = Buffer.alloc(OUTPUT_CAP),
      stderr = Buffer.alloc(ERROR_CAP);
    const refuse = (reason: string) => {
      fault ??= new Error(reason);
      if (!killRequested) {
        killRequested = true;
        child?.kill('SIGKILL');
      }
    };
    const timer = setTimeout(
      () => refuse('terminal Git timed out; awaiting actual close'),
      Math.max(1, Math.min(60_000, (count?.deadline ?? Date.now() + 60_000) - Date.now())),
    );
    try {
      child = spawn(
        session.bin,
        [...GIT_HARDEN, ...overrides.flatMap((setting) => ['-c', setting]), ...args],
        { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      clearTimeout(timer);
      resolveProcess();
      reject(error);
      return;
    }
    child.once('spawn', () => {
      spawned = true;
    });
    child.stdout!.on('data', (bytes: Buffer) => {
      if (stdoutBytes + bytes.length > OUTPUT_CAP) {
        refuse('terminal stdout bound reached');
        return;
      }
      if (!fault) {
        bytes.copy(stdout, stdoutBytes);
        stdoutBytes += bytes.length;
      }
    });
    child.stderr!.on('data', (bytes: Buffer) => {
      if (stderrBytes + bytes.length > ERROR_CAP) {
        refuse('terminal stderr bound reached');
        return;
      }
      if (!fault) {
        bytes.copy(stderr, stderrBytes);
        stderrBytes += bytes.length;
      }
    });
    child.once('error', (error) => {
      fault ??= error;
      if (!spawned && child.pid === undefined) {
        clearTimeout(timer);
        resolveProcess();
        reject(error);
      }
    });
    child.stdin!.on('error', (error: Error) => {
      fault ??= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveProcess();
      if (fault || code !== 0)
        reject(
          fault ??
            new Error(
              `terminal Git exit ${String(code)}: ${stderr.subarray(0, stderrBytes).toString('utf8')}`,
            ),
        );
      else done(Buffer.from(stdout.subarray(0, stdoutBytes)));
    });
    child.stdin!.end(options.input);
  });
  await (options.cleanup
    ? validateAddressTerminalAuthority(token)
    : validateEvidenceAuthority(token, options.count !== undefined));
  if (options.index === session.index) session.indexIdentity = await lstat(session.index);
  return output;
}

async function terminalPath(root: string, file: string) {
  if (
    !file ||
    isAbsolute(file) ||
    file.startsWith('-') ||
    file.split(/[\\/]/).some((part) => part === '..') ||
    /[*?\[\]{}]/.test(file)
  )
    throw new Error('terminal literal file refused');
  const canonical = await realpath(root);
  const path = resolve(canonical, file);
  if ((await realpath(path)) !== path) throw new Error('terminal path alias refused');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink())
    throw new Error('terminal file refused');
  return { root: canonical, path, stat };
}

/** Verify an already-created commit and record its canonical successor during shutdown too. */
export async function checkpointAddressTerminalEvidence(
  token: object,
  root: string,
  head?: string,
  expected?: { parent: string; tree: string },
): Promise<string> {
  root = await realpath(root);
  const session = await terminalSession(token, root, false, true);
  const git = (args: string[]) => terminalGit(token, session, root, args, { cleanup: true });
  const current = (await git(['rev-parse', 'HEAD'])).toString().trim();
  if ((head !== undefined && current !== head) || !/^[a-f0-9]{40,64}$/.test(current))
    throw new Error('terminal successor checkpoint changed');
  if (
    expected &&
    ((await git(['rev-parse', `${current}^`])).toString().trim() !== expected.parent ||
      (await git(['rev-parse', `${current}^{tree}`])).toString().trim() !== expected.tree)
  )
    throw new Error('commit does not match gated parent/tree');
  session.verifiedHeads ??= new Map();
  const heads = session.verifiedHeads.get(root) ?? new Set<string>();
  heads.add(current);
  session.verifiedHeads.set(root, heads);
  return current;
}

export async function noteAddressTerminalBookkeeping(
  token: object,
  root: string,
  entries: ReadonlyMap<string, string>,
) {
  const session = await terminalSession(token, root, false, true);
  session.bookkeeping = new Map(entries);
}

/** The private association admits only a candidate created by this worker. */
export async function removeAddressTerminalCandidate(
  token: object,
  root: string,
  candidate: string,
) {
  await validateAddressTerminalAuthority(token);
  const pending = terminalSessions.get(token);
  if (!pending) throw new Error('terminal cleanup session unavailable');
  const session = await pending;
  await terminalGit(token, session, root, ['worktree', 'remove', '--force', candidate], {
    cleanup: true,
  });
}

const ordinaryReports = new WeakMap<
  object,
  Map<string, { dev: number; ino: number; digest: string }>
>();
export async function noteAddressOrdinaryReport(token: object, path: string, bytes: string) {
  await validateAddressTerminalAuthority(token);
  const stat = await lstat(path);
  const digest = digestBytes(Buffer.from(bytes));
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    digestBytes(await boundedBytes(path, Buffer.byteLength(bytes))) !== digest
  )
    throw new Error('ordinary report changed before terminal adoption');
  const reports =
    ordinaryReports.get(token) ?? new Map<string, { dev: number; ino: number; digest: string }>();
  reports.set(path, { dev: stat.dev, ino: stat.ino, digest });
  ordinaryReports.set(token, reports);
}

export async function recordAddressTerminalEvidence(
  token: object,
  input: AddressTerminalAttemptInput,
): Promise<AddressTerminalAttempt> {
  const session = await terminalSession(token, input.root);
  if (++session.records > 64) throw new Error('terminal receipt bound reached');
  const path = await terminalPath(input.root, input.file);
  // Reserve before allocation, including concurrent captures. No refund/replay.
  if (path.stat.size > SOURCE_CAP || session.bytes + path.stat.size > TOTAL_CAP)
    throw new Error('terminal source snapshot/total bound reached');
  session.bytes += path.stat.size;
  const baseline = await boundedBytes(path.path, path.stat.size);
  const git = (args: string[]) => terminalGit(token, session, path.root, args);
  const gitDir = await realpath((await git(['rev-parse', '--absolute-git-dir'])).toString().trim());
  const common = await realpath(
    (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim(),
  );
  if (common !== session.common) throw new Error('terminal checkout common-dir changed');
  await validateEvidenceAuthority(token, false);
  const directory = await lstat(gitDir),
    gitEntry = await lstat(join(path.root, '.git'));
  if (!directory.isDirectory() || (!gitEntry.isFile() && !gitEntry.isDirectory()))
    throw new Error('terminal checkout entry refused');
  if (!session.checkouts.has(path.root))
    session.checkouts.set(path.root, {
      gitDir,
      directory,
      entry: gitEntry,
      ...(gitEntry.isFile()
        ? { link: digestBytes(await boundedBytes(join(path.root, '.git'), 4096)) }
        : {}),
    });
  const head = (await git(['rev-parse', 'HEAD'])).toString().trim();
  const branch = (await git(['symbolic-ref', 'HEAD'])).toString().trim();
  if (head !== input.parent) throw new Error('terminal baseline HEAD changed');
  const entry = (await git(['ls-files', '--stage', '-z', '--', input.file])).toString();
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== input.file) throw new Error('terminal baseline index entry refused');
  if (
    !baseline.equals(await git(['cat-file', 'blob', `${head}:${input.file}`])) ||
    !baseline.equals(await git(['cat-file', 'blob', match[2]!]))
  )
    throw new Error('terminal RAW baseline differs from committed blob');
  const mode = path.stat.mode & 0o111 ? '100755' : '100644';
  if (mode !== match[1]) throw new Error('terminal baseline mode refused');
  await validateEvidenceAuthority(token, false);
  return {
    ...input,
    model: { ...input.model },
    root: path.root,
    baseline,
    gitDir,
    branch,
    mode,
    blob: match[2]!,
    pathIdentity: path.stat,
    cancelled: false,
  };
}

// Hash worktree bytes directly: even a hardened worktree `git diff` can run
// repository clean filters. The fixed scratch buffer is never retained as
// evidence; unsupported non-RAW/large foreign files refuse conservatively.
async function terminalBlobIdentity(
  token: object,
  path: string,
  oidLength: number,
  expected: { dev: number; ino: number; mode: number },
): Promise<string> {
  await validateEvidenceAuthority(token, true);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > SOURCE_CAP ||
      !sameFile(before, expected) ||
      before.mode !== expected.mode
    )
      throw new Error('terminal foreign source identity/size refused');
    const hash = createHash(oidLength === 40 ? 'sha1' : 'sha256');
    hash.update(`blob ${before.size}\0`);
    const scratch = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      await validateEvidenceAuthority(token, true);
      const read = await fd.read(
        scratch,
        0,
        Math.min(scratch.length, before.size - offset),
        offset,
      );
      if (!read.bytesRead) throw new Error('terminal foreign source short read');
      hash.update(scratch.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await fd.stat(),
      named = await lstat(path);
    if (
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('terminal foreign source changed');
    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}

export async function settleAddressTerminalEvidence(
  token: object,
  attempts: readonly AddressTerminalAttempt[],
): Promise<void> {
  if (attempts.length > 64) throw new Error('terminal receipt bound reached');
  const deadline = Date.now() + 60_000;
  const paths = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.root}\0${attempt.file}`;
    if (paths.has(key)) throw new Error('terminal same-path receipts ambiguous');
    paths.add(key);
  }
  for (const attempt of attempts) {
    const session = await terminalSession(token, attempt.root, true);
    const count = { launches: 0, deadline };
    const git = (args: string[], index?: string, input?: Buffer) =>
      terminalGit(token, session, attempt.root, args, {
        count,
        ...(index ? { index } : {}),
        ...(input ? { input } : {}),
      });
    const verify = async (expected?: Buffer) => {
      await validateEvidenceAuthority(token, true);
      const source = await terminalPath(attempt.root, attempt.file);
      if (
        !sameFile(source.stat, attempt.pathIdentity) ||
        (source.stat.mode & 0o777) !== (attempt.pathIdentity.mode & 0o777)
      )
        throw new Error('terminal source identity changed');
      if ((await git(['symbolic-ref', 'HEAD'])).toString().trim() !== attempt.branch)
        throw new Error('terminal source branch changed');
      const head = (await git(['rev-parse', 'HEAD'])).toString().trim();
      if (head !== attempt.parent) {
        if (
          !session.verifiedHeads?.get(attempt.root)?.has(head) ||
          (
            await git([
              'diff',
              ...HARDENED_DIFF_FLAGS,
              '--name-only',
              '-z',
              attempt.parent,
              head,
              '--',
              attempt.file,
            ])
          ).length
        )
          throw new Error('terminal source HEAD changed');
      }
      // Stat-cache rewrites from a sibling restore are harmless. Workers edit
      // worktree bytes only: staged paths, modes and objects must match HEAD.
      const staged = (
        await git(['diff', ...HARDENED_DIFF_FLAGS, '--cached', '--name-only', '-z', head, '--'])
      )
        .toString()
        .split('\0')
        .filter(Boolean);
      if (staged.length) throw new Error('terminal source index changed');
      const tracked = (await git(['ls-files', '--stage', '-z'])).toString();
      // Iterate the bounded output without allocating an entry array first.
      let cursor = 0;
      while (cursor < tracked.length) {
        const end = tracked.indexOf('\0', cursor);
        if (end < 0) throw new Error('terminal index output incomplete');
        const entry = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(
          tracked.slice(cursor, end),
        );
        if (!entry) throw new Error('terminal foreign index entry unsupported');
        cursor = end + 1;
        const file = entry[3]!;
        if (paths.has(`${attempt.root}\0${file}`)) continue;
        const foreign = await terminalPath(attempt.root, file);
        const mode = foreign.stat.mode & 0o111 ? '100755' : '100644';
        if (
          mode !== entry[1] ||
          (await terminalBlobIdentity(token, foreign.path, entry[2]!.length, foreign.stat)) !==
            entry[2]
        )
          throw new Error('terminal foreign changed path; caller bytes retained');
      }
      const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z']))
        .toString()
        .split('\0')
        .filter(Boolean);
      for (const file of untracked) {
        const path = resolve(attempt.root, file);
        const expected = session.bookkeeping?.get(path);
        if (
          !expected ||
          (await realpath(path)) !== path ||
          digestBytes(await boundedBytes(path, REPORT_CAP)) !== expected
        )
          throw new Error('terminal unknown untracked path; caller bytes retained');
      }
      if (expected) {
        const hash = createHash(attempt.blob.length === 40 ? 'sha1' : 'sha256');
        hash.update(`blob ${expected.length}\0`);
        hash.update(expected);
        if (
          (await terminalBlobIdentity(token, source.path, attempt.blob.length, source.stat)) !==
          hash.digest('hex')
        )
          throw new Error('terminal source bytes changed');
        return { source, bytes: expected };
      }
      // Both baseline and cancelled receipt snapshots count before retention.
      if (source.stat.size > SOURCE_CAP || session.bytes + source.stat.size > TOTAL_CAP)
        throw new Error('terminal source snapshot/total bound reached');
      session.bytes += source.stat.size;
      const bytes = await boundedBytes(source.path, source.stat.size);
      return { source, bytes };
    };
    const { bytes } = await verify();
    if (bytes.equals(attempt.baseline)) continue;
    await git(['read-tree', attempt.parent], session.index);
    const blob = (await git(['hash-object', '-w', '--stdin'], session.index, bytes))
      .toString()
      .trim();
    if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error('terminal blob identity refused');
    await git(
      ['update-index', '--add', '--cacheinfo', attempt.mode, blob, attempt.file],
      session.index,
    );
    const pinned = await pinAddressFailure(
      async (args) => (await git(args, session.index)).toString().trim(),
      {
        runPrefix: attempt.runPrefix,
        kind: 'review',
        slug: attempt.slug,
        task: attempt.finding,
        parent: attempt.parent,
        firstAttempt: attempt.ordinal,
        tier: attempt.tier,
        model: attempt.model,
        gate: 'budget',
        outcome: 'escalated-to-human',
        reason: 'parent cancelled',
        pushFailed: false,
      },
    );
    // Record the real create effect before any later verification/restore failure.
    attempt.retained = {
      ...pinned,
      finding: attempt.finding,
      unit: `review/${attempt.slug}`,
      outcome: 'escalated-to-human',
      model: attempt.model,
      file: attempt.file,
      parent: attempt.parent,
      executionHead: attempt.executionHead,
      ordinal: Number(pinned.branch.slice(pinned.branch.lastIndexOf('/a') + 2)),
      tier: attempt.tier,
      gate: 'budget',
      reason: 'parent cancelled',
    };
    if (
      (await git(['rev-parse', '--verify', `refs/heads/${pinned.branch}`])).toString().trim() !==
        pinned.sha ||
      (await git(['rev-list', '--parents', '-n', '1', pinned.sha])).toString().trim() !==
        `${pinned.sha} ${attempt.parent}` ||
      !(await git(['cat-file', 'blob', `${pinned.sha}:${attempt.file}`])).equals(bytes)
    )
      throw new Error('terminal retained evidence verification failed');
    const changed = (
      await git(['diff', ...HARDENED_DIFF_FLAGS, '--name-only', '-z', attempt.parent, pinned.sha])
    )
      .toString()
      .split('\0')
      .filter(Boolean);
    if (changed.some((file) => file !== attempt.file))
      throw new Error('terminal evidence has foreign paths');
    const { source } = await verify(bytes);
    await validateEvidenceAuthority(token, true);
    const fd = await open(source.path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(await fd.stat(), source.stat))
        throw new Error('terminal source replaced before restore');
      await validateEvidenceAuthority(token, true);
      await fd.writeFile(attempt.baseline);
      await validateEvidenceAuthority(token, true);
      await fd.truncate(attempt.baseline.length);
      await validateEvidenceAuthority(token, true);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await validateEvidenceAuthority(token, true);
    await git(['update-index', '--cacheinfo', attempt.mode, attempt.blob, attempt.file]);
    const restored = createHash(attempt.blob.length === 40 ? 'sha1' : 'sha256');
    restored.update(`blob ${attempt.baseline.length}\0`);
    restored.update(attempt.baseline);
    if (
      (await terminalBlobIdentity(token, source.path, attempt.blob.length, source.stat)) !==
      restored.digest('hex')
    )
      throw new Error('terminal restoration not verified');
    await validateEvidenceAuthority(token, true);
    const indexIdentity = await lstat(session.index);
    if (
      !indexIdentity.isFile() ||
      indexIdentity.nlink !== 1 ||
      !session.indexIdentity ||
      !sameFile(indexIdentity, session.indexIdentity)
    )
      throw new Error('terminal private index changed');
    await unlink(session.index);
    delete session.indexIdentity;
  }
}

export async function persistAddressTerminalReport(
  token: object,
  path: string,
  report: unknown,
  directoryIdentity: { dev: number; ino: number },
): Promise<void> {
  await validateEvidenceAuthority(token, true);
  // Walk strings before serialization so a large body cannot force an unbounded
  // JSON allocation. Existing reports are trees; cycles are refused.
  let estimate = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 64 || estimate > REPORT_CAP) throw new Error('terminal report bound reached');
    if (typeof value === 'string') estimate += Buffer.byteLength(value) * 6 + 2;
    else if (value && typeof value === 'object') {
      if (seen.has(value)) throw new Error('terminal report cycle refused');
      seen.add(value);
      estimate += 16;
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          estimate += Buffer.byteLength(key) * 6 + 4;
          visit((value as Record<string, unknown>)[key], depth + 1);
        }
      seen.delete(value);
    } else estimate += 32;
  };
  visit(report, 0);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (bytes.length > REPORT_CAP) throw new Error('terminal report bound reached');
  await validateEvidenceAuthority(token, true);
  if (
    !sameFile(await lstat(dirname(path)), directoryIdentity) ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error('terminal report directory changed');
  const ordinary = ordinaryReports.get(token)?.get(path);
  if (
    ordinary &&
    (!sameFile(ordinary, await lstat(path)) ||
      digestBytes(await boundedBytes(path, REPORT_CAP)) !== ordinary.digest)
  )
    throw new Error('ordinary report replaced before terminal finalization');
  const fd = await open(
    path,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (ordinary ? 0 : constants.O_CREAT | constants.O_EXCL),
    0o600,
  );
  try {
    const created = await fd.stat();
    await validateEvidenceAuthority(token, true);
    if (
      !sameFile(created, await lstat(path)) ||
      !sameFile(await lstat(dirname(path)), directoryIdentity)
    )
      throw new Error('terminal report path changed');
    if (ordinary && !sameFile(created, ordinary))
      throw new Error('ordinary report identity changed');
    await fd.writeFile(bytes);
    await fd.truncate(bytes.length);
    await validateEvidenceAuthority(token, true);
    await fd.sync();
    if (!sameFile(created, await lstat(path))) throw new Error('terminal report replaced');
  } finally {
    await fd.close();
  }
  await validateEvidenceAuthority(token, true);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    if (!sameFile(await directory.stat(), directoryIdentity))
      throw new Error('terminal report directory replaced');
    await directory.sync();
  } finally {
    await directory.close();
  }
}
