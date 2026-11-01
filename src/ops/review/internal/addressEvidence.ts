import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  realpath,
  mkdir,
  open,
  writeFile,
  unlink,
  readdir,
  readlink,
} from 'node:fs/promises';
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
  expectedIndexes: Map<string, string>;
}
const terminalSessions = new WeakMap<object, Promise<TerminalSession>>();
type FileIdentity = { dev: number; ino: number; size: number; mode: number; nlink: number };
interface MaterializedReport {
  participant: object;
  directory: FileIdentity;
  ancestor: string;
  identity?: FileIdentity;
  hash?: string;
  length?: number;
  complete: boolean;
  fresh: boolean;
}
interface CandidateReceipt {
  participant: object;
  root: string;
  path: string;
  parent: string;
  file: string;
  created: boolean;
  removed: boolean;
  deferred: boolean;
  pending: number;
  unknown: boolean;
  directory?: FileIdentity;
  gitDir?: string;
  dependency?: string;
  index?: string;
  blob?: string;
  mode?: string;
  sourceIdentity?: FileIdentity;
  count?: { launches: number; deadline: number };
}
interface BookkeepingWitness {
  root: string;
  path: string;
  hash: string;
  identity: FileIdentity;
  head: string;
  branch: string;
}
interface ArtifactState {
  reports: Map<string, MaterializedReport>;
  candidates: Map<object, CandidateReceipt>;
  witnesses: Map<object, Map<string, BookkeepingWitness>>;
  paths: Set<string>;
  streamed: number;
  frozen: boolean;
  deadline?: number;
}
const artifactStates = new WeakMap<object, ArtifactState>();
const candidateChecks = new WeakMap<
  object,
  { token: object; participant: object; receipt: CandidateReceipt; settled: boolean }
>();
const capacityRefusals = new WeakSet<object>();
function capacity(reason: string): Error {
  const error = new Error(`address terminal capacity: ${reason}`);
  capacityRefusals.add(error);
  return error;
}
export function isAddressTerminalCapacityRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && capacityRefusals.has(error);
}
function artifacts(token: object): ArtifactState {
  let state = artifactStates.get(token);
  if (!state) {
    state = {
      reports: new Map(),
      candidates: new Map(),
      witnesses: new Map(),
      paths: new Set(),
      streamed: 0,
      frozen: false,
    };
    artifactStates.set(token, state);
  }
  return state;
}
export type AddressEvidenceAction =
  | { kind: 'report'; path: string; report: unknown }
  | { kind: 'hash'; path: string }
  | { kind: 'bookkeeping'; root: string; entries: readonly (readonly [string, string])[] }
  | { kind: 'candidate-intent'; root: string; path: string; parent: string; file: string }
  | { kind: 'candidate-created'; handle: object; dependency?: string }
  | { kind: 'candidate-baseline'; handle: object }
  | { kind: 'candidate-stage'; handle: object; content: Buffer }
  | { kind: 'candidate-removed'; handle: object }
  | { kind: 'candidate-removal-admit'; handle: object }
  | { kind: 'candidate-check'; root: string };
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
): Promise<TerminalSession> {
  await validateEvidenceAuthority(token, terminal);
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    throw new Error('terminal required no-follow/directory IO unsupported');
  let pending = terminalSessions.get(token);
  if (!pending) {
    pending = (async () => {
      const context = await validateEvidenceAuthority(token, terminal);
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
      await validateEvidenceAuthority(token, terminal);
      await mkdir(directory, { mode: 0o700 });
      const config = join(directory, 'empty-config');
      const hooks = join(directory, 'empty-hooks');
      await validateEvidenceAuthority(token, terminal);
      await mkdir(hooks, { mode: 0o700 });
      await validateEvidenceAuthority(token, terminal);
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
        expectedIndexes: new Map(),
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
  options: { input?: Buffer; index?: string; count?: { launches: number; deadline: number } } = {},
): Promise<Buffer> {
  await validateEvidenceAuthority(token, options.count !== undefined);
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
  await validateEvidenceAuthority(token, options.count !== undefined);
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
  await validateEvidenceAuthority(token, options.count !== undefined);
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

// Fixed data-only artifact operations. The token and participant association
// come from ownership; neither an injected op nor a callback receives them.
async function bookkeepingHash(token: object, path: string) {
  await validateAddressTerminalAuthority(token);
  if (Buffer.byteLength(path) > 4096 || (await realpath(path)) !== path)
    throw new Error('terminal bookkeeping canonical path refused');
  const state = artifacts(token);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 * 1024)
      throw capacity('bookkeeping file bound/identity refused');
    if (state.streamed + before.size > 16 * 1024 * 1024)
      throw capacity('bookkeeping streamed owner bound reached');
    state.streamed += before.size;
    const hash = createHash('sha256');
    const scratch = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await fd.read(
        scratch,
        0,
        Math.min(scratch.length, before.size - offset),
        offset,
      );
      if (!read.bytesRead) throw new Error('terminal bookkeeping shortened');
      hash.update(scratch.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await fd.stat(),
      named = await lstat(path);
    if (
      (await fd.read(scratch, 0, 1, offset)).bytesRead ||
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      named.nlink !== 1 ||
      named.size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('terminal bookkeeping changed while streaming');
    await validateAddressTerminalAuthority(token);
    return { identity: before, hash: hash.digest('hex') };
  } finally {
    await fd.close();
  }
}

function candidateFor(token: object, participant: object, handle: object): CandidateReceipt {
  const receipt = artifacts(token).candidates.get(handle);
  if (!receipt || receipt.participant !== participant || receipt.removed)
    throw new Error('terminal candidate forged/stale receipt');
  return receipt;
}

async function candidateBlobIdentity(
  token: object,
  path: string,
  oidLength: number,
  expected: FileIdentity,
  terminal: boolean,
) {
  await validateEvidenceAuthority(token, terminal);
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
      throw new Error('terminal candidate source identity/size refused');
    const hash = createHash(oidLength === 40 ? 'sha1' : 'sha256');
    hash.update(`blob ${before.size}\0`);
    const scratch = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      await validateEvidenceAuthority(token, terminal);
      const read = await fd.read(
        scratch,
        0,
        Math.min(scratch.length, before.size - offset),
        offset,
      );
      if (!read.bytesRead) throw new Error('terminal candidate shortened');
      hash.update(scratch.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await fd.stat(),
      named = await lstat(path);
    if (
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      named.nlink !== 1 ||
      named.size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('terminal candidate changed while streaming');
    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}

async function candidateGit(token: object, receipt: CandidateReceipt, terminal: boolean) {
  const session = await terminalSession(token, receipt.root, terminal);
  const count = terminal
    ? (receipt.count ??= {
        launches: 0,
        deadline: artifacts(token).deadline ?? Date.now() + 60_000,
      })
    : undefined;
  return {
    session,
    git: (root: string, args: string[]) =>
      terminalGit(token, session, root, args, count ? { count } : {}),
  };
}

async function verifyCandidate(
  token: object,
  receipt: CandidateReceipt,
  terminal: boolean,
  transition?: Buffer,
): Promise<void> {
  if (
    !receipt.created ||
    receipt.pending ||
    receipt.unknown ||
    !receipt.gitDir ||
    !receipt.directory
  )
    throw new Error('terminal candidate creation/check settlement unconfirmed');
  const { git } = await candidateGit(token, receipt, terminal);
  if (
    (await realpath(receipt.path)) !== receipt.path ||
    !sameFile(await lstat(receipt.path), receipt.directory)
  )
    throw new Error('terminal candidate directory changed');
  if (
    (await git(receipt.path, ['rev-parse', 'HEAD'])).toString().trim() !== receipt.parent ||
    (await boundedBytes(join(receipt.gitDir, 'HEAD'), 128)).toString().trim() !== receipt.parent
  )
    throw new Error('terminal candidate HEAD changed');
  const index = digestBytes(await boundedBytes(join(receipt.gitDir, 'index'), OUTPUT_CAP));
  if (!transition && index !== receipt.index) throw new Error('terminal candidate index changed');
  if (transition && transition.length > SOURCE_CAP)
    throw capacity('candidate source snapshot bound reached');
  const entry = (
    await git(receipt.path, ['ls-files', '--stage', '-z', '--', receipt.file])
  ).toString();
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== receipt.file || match[1] !== receipt.mode)
    throw new Error('terminal candidate staged source refused');
  let expected = receipt.blob!;
  if (transition) {
    const hash = createHash(expected.length === 40 ? 'sha1' : 'sha256');
    hash.update(`blob ${transition.length}\0`);
    hash.update(transition);
    expected = hash.digest('hex');
  }
  if (match[2] !== expected) throw new Error('terminal candidate engine transition mismatch');
  const diff = (
    await git(receipt.path, [
      'diff',
      ...HARDENED_DIFF_FLAGS,
      '--cached',
      '--raw',
      '--no-abbrev',
      '-z',
      receipt.parent,
    ])
  ).toString();
  if (diff) {
    const changed =
      /^:(100644|100755) (100644|100755) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) M\0([^\0]+)\0$/.exec(
        diff,
      );
    if (
      !changed ||
      changed[1] !== receipt.mode ||
      changed[2] !== receipt.mode ||
      changed[4] !== expected ||
      changed[5] !== receipt.file
    )
      throw new Error('terminal candidate foreign staged change');
  } else if (transition && expected !== receipt.blob)
    throw new Error('terminal candidate transition missing');
  const tracked = (await git(receipt.path, ['ls-files', '--stage', '-z'])).toString();
  let cursor = 0;
  while (cursor < tracked.length) {
    const end = tracked.indexOf('\0', cursor);
    const row =
      end < 0
        ? null
        : /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)$/.exec(tracked.slice(cursor, end));
    if (!row) throw new Error('terminal candidate index output incomplete');
    cursor = end + 1;
    const source = await terminalPath(receipt.path, row[3]!);
    if (
      (source.stat.mode & 0o111 ? '100755' : '100644') !== row[1] ||
      (await candidateBlobIdentity(token, source.path, row[2]!.length, source.stat, terminal)) !==
        row[2]
    )
      throw new Error('terminal candidate check/feedback changed bytes');
    if (
      row[3] === receipt.file &&
      receipt.sourceIdentity &&
      !sameFile(source.stat, receipt.sourceIdentity)
    )
      throw new Error('terminal candidate source inode changed');
  }
  const untracked = (
    await git(receipt.path, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).toString();
  if (untracked && untracked !== 'node_modules\0')
    throw new Error('terminal candidate unknown untracked file');
  // Check the dependency entry even when an ignore rule hides it from Git.
  try {
    const stat = await lstat(join(receipt.path, 'node_modules'));
    if (
      !receipt.dependency ||
      !stat.isSymbolicLink() ||
      (await readlink(join(receipt.path, 'node_modules'))) !== receipt.dependency ||
      (await realpath(join(receipt.path, 'node_modules'))) !== receipt.dependency
    )
      throw new Error('terminal candidate dependency link changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || receipt.dependency) throw error;
  }
  if (transition) {
    receipt.index = index;
    receipt.blob = expected;
  }
}

export function finishAddressCandidateCheck(
  token: object,
  participant: object,
  handle: object,
  known: boolean,
): void {
  const check = candidateChecks.get(handle);
  if (
    !check ||
    check.token !== token ||
    check.participant !== participant ||
    check.settled ||
    artifacts(token).frozen
  )
    throw new Error('terminal candidate forged/replayed check receipt');
  check.settled = true;
  check.receipt.pending--;
  if (!known) check.receipt.unknown = true;
}
export function deferAddressCandidate(token: object, participant: object, handle: object): void {
  const receipt = candidateFor(token, participant, handle);
  if (artifacts(token).frozen) throw new Error('terminal candidate after freeze');
  receipt.deferred = true;
}

export async function addressEvidenceAction(
  token: object,
  participant: object,
  action: AddressEvidenceAction,
): Promise<unknown> {
  const state = artifacts(token);
  if (state.frozen) throw new Error('terminal artifact revisions frozen');
  if (action.kind === 'report')
    return materializeAddressReport(token, participant, action.path, action.report);
  if (action.kind === 'hash') return (await bookkeepingHash(token, action.path)).hash;
  if (action.kind === 'bookkeeping') {
    if (action.entries.length > 256) throw capacity('bookkeeping witness owner bound reached');
    if (!action.entries.length) {
      if (!state.witnesses.has(participant)) state.witnesses.set(participant, new Map());
      return;
    }
    const context = await validateAddressTerminalAuthority(token);
    if (context.terminal && !terminalSessions.has(token))
      throw new Error('terminal bookkeeping creation after cancellation refused');
    const session = await terminalSession(token, action.root, context.terminal);
    const count = context.terminal ? { launches: 0, deadline: Date.now() + 60_000 } : undefined;
    const git = (args: string[]) =>
      terminalGit(token, session, action.root, args, count ? { count } : {});
    const root = await realpath(action.root);
    const gitDir = await realpath(
      (await git(['rev-parse', '--absolute-git-dir'])).toString().trim(),
    );
    const common = await realpath(
      (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim(),
    );
    if (common !== session.common)
      throw new Error('terminal bookkeeping checkout common-dir changed');
    const entry = await lstat(join(root, '.git')),
      directory = await lstat(gitDir);
    if (!directory.isDirectory() || (!entry.isDirectory() && !entry.isFile()))
      throw new Error('terminal bookkeeping checkout entry refused');
    if (!session.checkouts.has(root))
      session.checkouts.set(root, {
        gitDir,
        directory,
        entry,
        ...(entry.isFile()
          ? { link: digestBytes(await boundedBytes(join(root, '.git'), 4096)) }
          : {}),
      });
    const head = (await git(['rev-parse', 'HEAD'])).toString().trim();
    const branch = (await git(['symbolic-ref', 'HEAD'])).toString().trim();
    const next = new Map(state.witnesses.get(participant));
    for (const [path, hash] of action.entries) {
      const rel = relative(root, path);
      if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
      if (!state.paths.has(path) && state.paths.size >= 256)
        throw capacity('bookkeeping witness owner bound reached');
      state.paths.add(path);
      const observed = await bookkeepingHash(token, path);
      if (observed.hash !== hash) throw new Error('terminal bookkeeping revision changed');
      next.set(path, { root, path, hash, identity: observed.identity, head, branch });
    }
    // No partially read revision is published, and old witnesses never refund
    // the owner-wide path/stream bounds.
    state.witnesses.set(participant, next);
    return;
  }
  await validateEvidenceAuthority(token, false);
  if (action.kind === 'candidate-intent') {
    if (state.candidates.size >= 128) throw capacity('candidate owner receipt bound reached');
    const root = await realpath(action.root),
      path = resolve(action.path);
    if (
      Buffer.byteLength(path) > 4096 ||
      !isAbsolute(path) ||
      path === root ||
      !/^(?:failed-)?candidate-[a-f0-9-]{36}$/.test(path.slice(path.lastIndexOf('/') + 1))
    )
      throw new Error('terminal candidate intent path refused');
    try {
      await lstat(path);
      throw new Error('terminal candidate intent target exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if ([...state.candidates.values()].some((entry) => entry.path === path))
      throw new Error('terminal candidate alias');
    if (state.candidates.size >= 128) throw capacity('candidate owner receipt bound reached');
    const handle = Object.freeze({});
    state.candidates.set(handle, {
      participant,
      root,
      path,
      parent: action.parent,
      file: action.file,
      created: false,
      removed: false,
      deferred: false,
      pending: 0,
      unknown: false,
    });
    return handle;
  }
  if (action.kind === 'candidate-check') {
    const root = await realpath(action.root);
    const receipt = [...state.candidates.values()].find(
      (entry) => entry.participant === participant && entry.path === root && !entry.removed,
    );
    if (!receipt) throw new Error('terminal candidate check has no creation receipt');
    await verifyCandidate(token, receipt, false);
    const handle = Object.freeze({});
    receipt.pending++;
    candidateChecks.set(handle, { token, participant, receipt, settled: false });
    return handle;
  }
  const receipt = candidateFor(token, participant, action.handle);
  if (action.kind === 'candidate-removed') {
    await verifyCandidateAbsent(token, receipt, false);
    receipt.removed = true;
    return;
  }
  if (action.kind === 'candidate-created') {
    if (receipt.created) throw new Error('terminal candidate creation replayed');
    const { session, git } = await candidateGit(token, receipt, false);
    const gitDir = await realpath(
      (await git(receipt.path, ['rev-parse', '--absolute-git-dir'])).toString().trim(),
    );
    if (
      (await realpath(receipt.path)) !== receipt.path ||
      (await realpath(
        (await git(receipt.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
          .toString()
          .trim(),
      )) !== session.common
    )
      throw new Error('terminal candidate checkout identity refused');
    const directory = await lstat(receipt.path),
      entry = await lstat(join(receipt.path, '.git'));
    if (!directory.isDirectory() || !entry.isFile() || entry.nlink !== 1)
      throw new Error('terminal candidate entry refused');
    const source = await terminalPath(receipt.path, receipt.file);
    const row = (
      await git(receipt.path, ['ls-files', '--stage', '-z', '--', receipt.file])
    ).toString();
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/.exec(row);
    if (
      !match ||
      match[3] !== receipt.file ||
      (
        await git(receipt.path, [
          'diff',
          ...HARDENED_DIFF_FLAGS,
          '--cached',
          '--raw',
          '-z',
          receipt.parent,
        ])
      ).length
    )
      throw new Error('terminal candidate creation baseline changed');
    session.checkouts.set(receipt.path, {
      gitDir,
      directory: await lstat(gitDir),
      entry,
      link: digestBytes(await boundedBytes(join(receipt.path, '.git'), 4096)),
    });
    receipt.directory = directory;
    receipt.gitDir = gitDir;
    receipt.sourceIdentity = source.stat;
    receipt.index = digestBytes(await boundedBytes(join(gitDir, 'index'), OUTPUT_CAP));
    receipt.blob = match[2]!;
    receipt.mode = match[1]!;
    if (action.dependency) receipt.dependency = await realpath(action.dependency);
    receipt.created = true;
    await verifyCandidate(token, receipt, false);
    return;
  }
  if (action.kind === 'candidate-baseline' || action.kind === 'candidate-removal-admit')
    return verifyCandidate(token, receipt, false);
  if (action.kind === 'candidate-stage')
    return verifyCandidate(token, receipt, false, action.content);
  throw new Error('terminal evidence action refused');
}

async function verifyCandidateAbsent(token: object, receipt: CandidateReceipt, terminal: boolean) {
  try {
    await lstat(receipt.path);
    throw new Error('terminal candidate removal not observed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { git } = await candidateGit(token, receipt, terminal);
  const listing = (await git(receipt.root, ['worktree', 'list', '--porcelain', '-z'])).toString();
  if (!listing.endsWith('\0') || listing.split('\0').includes(`worktree ${receipt.path}`))
    throw new Error('terminal candidate registration removal unconfirmed');
}

async function frozenWitnesses(token: object) {
  const union = new Map<string, BookkeepingWitness>();
  for (const revision of artifacts(token).witnesses.values())
    for (const [path, witness] of revision) {
      const previous = union.get(path);
      if (
        previous &&
        (previous.hash !== witness.hash ||
          !sameFile(previous.identity, witness.identity) ||
          previous.head !== witness.head ||
          previous.branch !== witness.branch ||
          previous.root !== witness.root)
      )
        throw new Error('terminal conflicting sibling bookkeeping witnesses');
      union.set(path, witness);
    }
  for (const witness of union.values()) {
    const observed = await bookkeepingHash(token, witness.path);
    if (
      observed.hash !== witness.hash ||
      !sameFile(observed.identity, witness.identity) ||
      observed.identity.size !== witness.identity.size ||
      observed.identity.mode !== witness.identity.mode
    )
      throw new Error('terminal bookkeeping identity/content changed');
    const session = await terminalSession(token, witness.root, true);
    const count = { launches: 0, deadline: Date.now() + 60_000 };
    if (
      (await terminalGit(token, session, witness.root, ['rev-parse', 'HEAD'], { count }))
        .toString()
        .trim() !== witness.head ||
      (await terminalGit(token, session, witness.root, ['symbolic-ref', 'HEAD'], { count }))
        .toString()
        .trim() !== witness.branch
    )
      throw new Error('terminal bookkeeping checkout changed');
  }
  return union;
}

export async function preflightAddressTerminalArtifacts(
  token: object,
  reports: readonly { path: string; directory: { dev: number; ino: number }; report: unknown }[],
): Promise<void> {
  await validateEvidenceAuthority(token, true);
  const state = artifacts(token);
  if (state.frozen) throw new Error('terminal artifact freeze replayed');
  state.frozen = true;
  state.deadline = Date.now() + 60_000;
  await frozenWitnesses(token);
  for (const receipt of state.candidates.values()) {
    if (receipt.removed) await verifyCandidateAbsent(token, receipt, true);
    else if (!receipt.deferred) throw new Error('terminal candidate has no cleanup arrival');
    else await verifyCandidate(token, receipt, true);
  }
  for (const report of reports) {
    terminalReportBytes(report.report);
    await verifyReportAdoption(token, report.path, report.directory);
  }
}
export async function removeAddressTerminalCandidates(token: object): Promise<void> {
  for (const receipt of artifacts(token).candidates.values()) {
    if (receipt.removed) continue;
    await verifyCandidate(token, receipt, true);
    const { git } = await candidateGit(token, receipt, true);
    // The sole terminal worktree mutation: no add/prune/arbitrary argv.
    await git(receipt.root, ['worktree', 'remove', '--force', receipt.path]);
    await verifyCandidateAbsent(token, receipt, true);
    receipt.removed = true;
  }
}

export async function recordAddressTerminalEvidence(
  token: object,
  input: AddressTerminalAttemptInput,
): Promise<AddressTerminalAttempt> {
  const session = await terminalSession(token, input.root);
  if (++session.records > 64) throw capacity('terminal receipt bound reached');
  const path = await terminalPath(input.root, input.file);
  // Reserve before allocation, including concurrent captures. No refund/replay.
  if (path.stat.size > SOURCE_CAP || session.bytes + path.stat.size > TOTAL_CAP)
    throw capacity('terminal source snapshot/total bound reached');
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
  const indexHash = digestBytes(await boundedBytes(join(gitDir, 'index'), OUTPUT_CAP));
  session.expectedIndexes.set(gitDir, indexHash);
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
  const prepared = [];
  const witnesses = await frozenWitnesses(token);
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
      if ((await git(['rev-parse', 'HEAD'])).toString().trim() !== attempt.parent)
        throw new Error('terminal source HEAD changed');
      const hash = digestBytes(await boundedBytes(join(attempt.gitDir, 'index'), OUTPUT_CAP));
      if (hash !== session.expectedIndexes.get(attempt.gitDir))
        throw new Error('terminal source index changed');
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
      const untracked = (
        await git(['ls-files', '--others', '--exclude-standard', '-z'])
      ).toString();
      let untrackedCursor = 0;
      while (untrackedCursor < untracked.length) {
        const end = untracked.indexOf('\0', untrackedCursor);
        if (end < 0) throw new Error('terminal untracked output incomplete');
        const path = resolve(attempt.root, untracked.slice(untrackedCursor, end));
        untrackedCursor = end + 1;
        const witness = witnesses.get(path);
        if (!witness || witness.root !== attempt.root)
          throw new Error('terminal unknown untracked path; caller bytes retained');
        const observed = await bookkeepingHash(token, path);
        if (observed.hash !== witness.hash || !sameFile(observed.identity, witness.identity))
          throw new Error('terminal bookkeeping changed before source restore');
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
    prepared.push({ attempt, session, git, verify, bytes });
  }
  // Every source/index/HEAD guard has passed before any object/ref/source write.
  for (const { attempt, session, git, verify, bytes } of prepared) {
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
    session.expectedIndexes.set(
      attempt.gitDir,
      digestBytes(await boundedBytes(join(attempt.gitDir, 'index'), OUTPUT_CAP)),
    );
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

function terminalReportBytes(report: unknown): Buffer {
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
  return bytes;
}

async function verifyReportAdoption(
  token: object,
  path: string,
  directory: { dev: number; ino: number },
) {
  const receipt = artifacts(token).reports.get(path);
  if (
    !sameFile(await lstat(dirname(path)), directory) ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error('terminal report directory changed');
  if (receipt && (!receipt.fresh || !receipt.complete || !receipt.identity || !receipt.hash))
    throw new Error('terminal report partial/unowned materialization refused');
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || receipt) throw error;
    return;
  }
  if (
    !receipt ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !sameFile(stat, receipt.identity!) ||
    stat.size !== receipt.length ||
    !sameFile(directory, receipt.directory) ||
    receipt.ancestor !== dirname(path)
  )
    throw new Error('terminal report existing target is not authenticated output');
  const bytes = await boundedBytes(path, REPORT_CAP);
  if (bytes.length !== receipt.length || digestBytes(bytes) !== receipt.hash)
    throw new Error('terminal report authenticated output changed');
}

async function materializeAddressReport(
  token: object,
  participant: object,
  path: string,
  report: unknown,
): Promise<void> {
  await validateEvidenceAuthority(token, false);
  if (resolve(path) !== path || (await realpath(dirname(path))) !== dirname(path))
    throw new Error('normal report canonical target refused');
  const directory = await lstat(dirname(path));
  const state = artifacts(token);
  const previous = state.reports.get(path);
  // Keep ordinary overwrite compatibility, but a pre-existing/oversized output
  // earns no private terminal adoption receipt.
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  let fd;
  let fresh = false;
  if (bytes.length <= REPORT_CAP) {
    try {
      await validateEvidenceAuthority(token, false);
      fd = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fresh = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (previous?.participant === participant && previous.complete && previous.fresh) {
        await verifyReportAdoption(token, path, directory);
        fd = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
        fresh = true;
      }
    }
  }
  const receipt: MaterializedReport = {
    participant,
    directory,
    ancestor: dirname(path),
    complete: false,
    fresh,
  };
  state.reports.set(path, receipt);
  if (!fd) {
    await validateEvidenceAuthority(token, false);
    await writeFile(path, bytes, { mode: 0o600 });
    // Existing/oversized normal writes are intentionally never adopted.
    return;
  }
  try {
    const identity = await fd.stat();
    if (
      !identity.isFile() ||
      identity.nlink !== 1 ||
      !sameFile(identity, await lstat(path)) ||
      (previous?.fresh && previous.complete && !sameFile(identity, previous.identity!))
    )
      throw new Error('normal report opened identity changed');
    await validateEvidenceAuthority(token, false);
    await fd.writeFile(bytes);
    // Fresh exclusive files already have exactly this length. A normal rewrite
    // needing truncation is a separate mutation, never admitted after abort.
    if (identity.size > bytes.length) {
      await validateEvidenceAuthority(token, false);
      await fd.truncate(bytes.length);
    }
    await validateAddressTerminalAuthority(token);
    receipt.identity = await fd.stat();
    if (
      !sameFile(identity, receipt.identity) ||
      !sameFile(identity, await lstat(path)) ||
      receipt.identity.nlink !== 1 ||
      receipt.identity.size !== bytes.length ||
      !sameFile(directory, await lstat(dirname(path)))
    )
      throw new Error('normal report materialization changed');
  } finally {
    // A write promise completing is not positive close evidence.
    await fd.close();
  }
  const observed = await boundedBytes(path, REPORT_CAP);
  await validateAddressTerminalAuthority(token);
  if (!observed.equals(bytes)) throw new Error('normal report content changed before receipt');
  receipt.hash = digestBytes(bytes);
  receipt.length = bytes.length;
  receipt.complete = true;
}

export async function persistAddressTerminalReport(
  token: object,
  path: string,
  report: unknown,
  directoryIdentity: { dev: number; ino: number },
): Promise<void> {
  await validateEvidenceAuthority(token, true);
  const bytes = terminalReportBytes(report);
  await verifyReportAdoption(token, path, directoryIdentity);
  const prior = artifacts(token).reports.get(path);
  const fd = await open(
    path,
    prior
      ? constants.O_RDWR | constants.O_NOFOLLOW
      : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const receipt: MaterializedReport = {
    participant: prior?.participant ?? Object.freeze({}),
    directory: await lstat(dirname(path)),
    ancestor: dirname(path),
    complete: false,
    fresh: true,
  };
  artifacts(token).reports.set(path, receipt);
  try {
    const created = await fd.stat();
    await validateEvidenceAuthority(token, true);
    if (
      !created.isFile() ||
      created.nlink !== 1 ||
      !sameFile(created, await lstat(path)) ||
      !sameFile(await lstat(dirname(path)), directoryIdentity) ||
      (prior && !sameFile(created, prior.identity!))
    )
      throw new Error('terminal report path changed');
    if (prior && digestBytes(await boundedBytes(path, REPORT_CAP)) !== prior.hash)
      throw new Error('terminal report revision changed before write');
    await validateEvidenceAuthority(token, true);
    await fd.writeFile(bytes);
    await validateEvidenceAuthority(token, true);
    await fd.truncate(bytes.length);
    await validateEvidenceAuthority(token, true);
    await fd.sync();
    receipt.identity = await fd.stat();
    if (
      !sameFile(created, await lstat(path)) ||
      receipt.identity.nlink !== 1 ||
      receipt.identity.size !== bytes.length
    )
      throw new Error('terminal report replaced');
  } finally {
    await fd.close();
  }
  await validateEvidenceAuthority(token, true);
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!sameFile(await directory.stat(), directoryIdentity))
      throw new Error('terminal report directory replaced');
    await directory.sync();
  } finally {
    await directory.close();
  }
  receipt.hash = digestBytes(bytes);
  receipt.length = bytes.length;
  receipt.complete = true;
}
