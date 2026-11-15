/**
 * Real effects and the command line of `apps/crq-python/ops/prepare-host.py`:
 * `atomic_bytes`, `require_outside_git`, `load_overlay`, `tick_lock`, the
 * `SwitchEffects`/`PrepareEffects`/`LegacyEffects` bindings and `main`.
 * Inactive and unimported. Every process, clock and lock access still goes
 * through a seam (`RunProcess`, `HostEnv`) so the tests can drive the real
 * filesystem and real `git` without touching systemd.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { posix } from 'node:path';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../policy/crq/jsonValue.js';
import {
  CalledProcessError,
  legacyCheck,
  prepare,
  record,
  renderAt,
  rootCheck,
  switchCheckout,
  type LegacyEffects,
  type PrepareEffects,
  type SystemctlResult,
} from './deployOps.js';
import { outside, validate, ValueError } from './hostOverlay.js';
import { liveRender, renderPlists, type PlistEffects } from './plistRender.js';
import { pyText, renderUnits } from './renderService.js';
import { posixStr } from './unitRender.js';
import { flockLockFs, type FlockLockFs } from './flockAdapter.js';

const CONFIG_PATH = 'apps/crq-python/config.json';
const SYSTEMD_DIR = 'apps/crq-python/ops/systemd';
const OPS_DIR = 'apps/crq-python/ops';
const STATE_DIR = 'apps/crq-python/state';

// ---- Python reprs -------------------------------------------------------

/** Python `repr(str)`. */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + quote;
}
const pyListRepr = (items: readonly string[]): string => `[${items.map(pyStrRepr).join(', ')}]`;

/** `subprocess.CalledProcessError` with the argv-only `str()` Python gives. */
export function calledProcessError(
  argv: readonly string[],
  code: number,
  stderr: string,
): CalledProcessError {
  return new CalledProcessError(
    code,
    stderr,
    `Command ${pyListRepr(argv)} returned non-zero exit status ${code}.`,
  );
}

// ---- processes ----------------------------------------------------------

export interface ProcessResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
/** Run `argv`, resolve with the exit status; reject only when it cannot start. */
export type RunProcess = (argv: readonly string[]) => Promise<ProcessResult>;

export const runProcess: RunProcess = (argv) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const [file, ...args] = argv;
    const child = spawn(file as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve({
        code: code ?? (signal === null ? 1 : -1),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      }),
    );
  });

const text = (data: Uint8Array): string => pyText(data);

/** `subprocess.run(argv, check=True, capture_output=True)` stdout bytes. */
async function checked(run: RunProcess, argv: readonly string[]): Promise<Uint8Array> {
  const result = await run(argv);
  if (result.code !== 0) throw calledProcessError(argv, result.code, text(result.stderr));
  return result.stdout;
}

// ---- Path.resolve -------------------------------------------------------

/** `Path(path).resolve()` (non-strict): symlinks of the existing prefix are followed. */
export function pyResolve(path: string): string {
  let current = posix.resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length ? posix.join(real, ...rest.reverse()) : real;
    } catch {
      if (current === '/') return '/';
      rest.push(posix.basename(current));
      current = posix.dirname(current);
    }
  }
}

// ---- atomic_bytes -------------------------------------------------------

/** Temp file in the target directory, fsync, rename over, fsync the directory. */
export async function atomicBytes(path: string, data: Uint8Array): Promise<void> {
  const dir = posix.dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = posix.join(dir, `.${posix.basename(path)}${randomUUID().slice(0, 8)}`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}

// ---- require_outside_git / load_overlay ---------------------------------

export interface OverlayEnv {
  run: RunProcess;
}
/** Refuses a path whose nearest existing directory is inside any Git checkout. */
export async function requireOutsideGit(path: string, env: OverlayEnv): Promise<void> {
  let parent = pyResolve(path);
  for (;;) {
    try {
      if (statSync(parent).isDirectory()) break;
    } catch {
      /* not there: climb */
    }
    const up = posix.dirname(parent);
    if (up === parent) break;
    parent = up;
  }
  const result = await env.run(['git', '-C', parent, 'rev-parse', '--show-toplevel']);
  if (result.code === 0)
    throw new ValueError('private host artifacts must be outside every Git checkout');
}

export interface LoadedOverlay {
  readonly overlay: JsonObject;
  readonly raw: Uint8Array;
}
export async function loadOverlay(path: string, env: OverlayEnv): Promise<LoadedOverlay> {
  const resolved = pyResolve(path);
  await requireOutsideGit(resolved, env);
  if (((await stat(resolved)).mode & 0o077) !== 0)
    throw new ValueError('private overlay must have mode 0600');
  const raw = new Uint8Array(await readFile(resolved));
  let value: JsonValue;
  try {
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
    value = parseJsonValue(body);
  } catch (error) {
    throw new ValueError(error instanceof Error ? error.message : String(error));
  }
  const overlay = validate(value, pyResolve);
  const root = overlay.get('deploy_root') as string;
  if (!outside(resolved, root, pyResolve))
    throw new ValueError('overlay must be outside the checkout');
  return { overlay, raw };
}

// ---- tick_lock ----------------------------------------------------------

/** `BlockingIOError` from `fcntl.flock(LOCK_EX | LOCK_NB)`. */
export class BlockingIOError extends Error {
  override name = 'BlockingIOError';
  constructor() {
    super('[Errno 11] Resource temporarily unavailable');
  }
}
/**
 * `with tick_lock(root):` over the flock adapter. Creates the state directory
 * (not its parents), takes the non-blocking lock on `state/tick.lock`, runs
 * `fn`, and always releases.
 */
export async function withTickLock<T>(
  lockFs: FlockLockFs,
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const state = `${posixStr(root)}/${STATE_DIR}`;
  try {
    await mkdir(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const handle = await lockFs.tryLock(`${state}/tick.lock`);
  if (handle === null) throw new BlockingIOError();
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

// ---- effects bindings ---------------------------------------------------

export interface HostEnv {
  run: RunProcess;
  lockFs: FlockLockFs;
  home(): string;
  now(): Date;
  uuidHex(): string;
}
export function realHostEnv(): HostEnv {
  return {
    run: runProcess,
    lockFs: flockLockFs(),
    home: homedir,
    now: () => new Date(),
    uuidHex: () => randomUUID().replace(/-/g, ''),
  };
}

/** `datetime.now(timezone.utc).isoformat()`, from millisecond input. */
export function isoUtc(now: Date): string {
  const base = now.toISOString().slice(0, 19);
  const ms = now.getUTCMilliseconds();
  return `${base}${ms === 0 ? '' : `.${String(ms).padStart(3, '0')}000`}+00:00`;
}

export interface HostBundle extends PrepareEffects {
  /** `render_units(root, output)` at HEAD. */
  renderUnitsInto(output: string): Promise<void>;
  plistEffects(output: string, overlayPath: string): PlistEffects;
}

export function hostBundle(
  env: HostEnv,
  root: string,
  overlay: JsonObject,
  raw: Uint8Array,
  options: { output?: string } = {},
): HostBundle {
  const git = (args: readonly string[]): Promise<Uint8Array> =>
    checked(env.run, ['git', '-C', root, ...args]);
  const config = `${posixStr(root)}/${CONFIG_PATH}`;
  const base: Pick<HostBundle, 'git' | 'resolve'> = { git, resolve: pyResolve };
  const recordEffects = {
    git,
    requireOutsideGit: (directory: string) => requireOutsideGit(directory, env),
    mkdirPrivate: async (directory: string) =>
      void (await mkdir(directory, { recursive: true, mode: 0o700 })),
    mode: async (directory: string) => (await stat(directory)).mode,
    nowIso: () => isoUtc(env.now()),
    uuidHex: env.uuidHex,
    atomicWrite: atomicBytes,
  };
  const unitEffects = {
    git,
    mkdir: async (path: string) => void (await mkdir(path, { recursive: true })),
    atomicWrite: atomicBytes,
  };
  const output = options.output ?? '';
  return {
    ...base,
    unitFiles: async () => {
      try {
        return (await readdir(`${posixStr(root)}/${SYSTEMD_DIR}`))
          .filter((name) => name.startsWith('crq-'))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    systemctl: async (args): Promise<SystemctlResult> => {
      const result = await env.run(['systemctl', ...args]);
      return { code: result.code, stdout: text(result.stdout), stderr: text(result.stderr) };
    },
    withTickLock: (fn) => withTickLock(env.lockFs, root, fn),
    readConfig: async () => new Uint8Array(await readFile(config)),
    writeConfig: (data) => atomicBytes(config, data),
    record: async (data, operation, extra) => {
      await record(recordEffects, overlay, raw, data, operation, extra);
    },
    renderUnitsToTemp: async (sha, use) => {
      const dir = await mkdtemp(posix.join(tmpdir(), 'crq-units-'));
      try {
        return await use(await renderUnits(unitEffects, root, dir, env.home(), { sha }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    verifyUnits: async (paths) => {
      await checked(env.run, ['systemd-analyze', '--user', 'verify', ...paths]);
    },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    mkdirOutput: async () => void (await mkdir(output, { recursive: true })),
    writeOutput: (name, data) => atomicBytes(`${posixStr(output)}/${name}`, data),
    writeMarker: (data) => atomicBytes(`${posixStr(root)}/${STATE_DIR}/runner-disabled`, data),
    daemonReload: async () => {
      await checked(env.run, ['systemctl', '--user', 'daemon-reload']);
    },
    renderUnitsInto: async (dir) => {
      await renderUnits(unitEffects, root, dir, env.home());
    },
    plistEffects: (dir, overlayPath) => ({
      mkdir: async () => void (await mkdir(dir, { recursive: true })),
      listPlists: async () =>
        (await readdir(`${posixStr(root)}/${OPS_DIR}`))
          .filter((name) => /^com\.crq\..*\.plist$/s.test(name))
          .sort(),
      readFile: async (name) =>
        new Uint8Array(await readFile(`${posixStr(root)}/${OPS_DIR}/${name}`)),
      atomicWrite: (name, data) => atomicBytes(`${posixStr(dir)}/${name}`, data),
      overlayPath: () => pyResolve(overlayPath),
      home: env.home,
    }),
  };
}

export function legacyBundle(
  env: HostEnv,
  legacyRoot: string,
  overlay: JsonObject,
  raw: Uint8Array,
): LegacyEffects {
  const git = (args: readonly string[]): Promise<Uint8Array> =>
    checked(env.run, ['git', '-C', legacyRoot, ...args]);
  const recordEffects = {
    git,
    requireOutsideGit: (directory: string) => requireOutsideGit(directory, env),
    mkdirPrivate: async (directory: string) =>
      void (await mkdir(directory, { recursive: true, mode: 0o700 })),
    mode: async (directory: string) => (await stat(directory)).mode,
    nowIso: () => isoUtc(env.now()),
    uuidHex: env.uuidHex,
    atomicWrite: atomicBytes,
  };
  return {
    git,
    readConfig: async () => new Uint8Array(await readFile(`${posixStr(legacyRoot)}/config.json`)),
    record: async (data, operation, extra) => {
      await record(recordEffects, overlay, raw, data, operation, extra);
    },
  };
}

// ---- main ---------------------------------------------------------------

export interface MainDeps {
  env: HostEnv;
}
export interface MainResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Args {
  overlay: string;
  operation: string;
  unitsOutput?: string | undefined;
  tag?: string | null | undefined;
  output?: string | undefined;
  sha?: string | undefined;
  legacyRoot?: string | undefined;
}
class UsageError extends Error {}

const OPERATIONS: Readonly<Record<string, readonly (readonly [string, boolean])[]>> = {
  'live-config': [],
  prepare: [
    ['--units-output', true],
    ['--tag', true],
  ],
  preview: [['--output', true]],
  switch: [
    ['--sha', true],
    ['--tag', false],
  ],
  'legacy-check': [['--legacy-root', true]],
};

/** argparse option lookup: exact, `--opt=value`, or a unique prefix (`allow_abbrev`). */
function lookup(flag: string, known: readonly string[]): string {
  if (known.includes(flag)) return flag;
  const hits = known.filter((name) => name.startsWith(flag));
  if (hits.length === 1) return hits[0] as string;
  if (hits.length > 1)
    throw new UsageError(`ambiguous option: ${flag} could match ${hits.join(', ')}`);
  throw new UsageError(`unrecognized arguments: ${flag}`);
}
function readOptions(
  tokens: readonly string[],
  start: number,
  known: readonly string[],
  stop: boolean,
): { values: Map<string, string>; next: number } {
  const values = new Map<string, string>();
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (!token.startsWith('-') || token === '-') {
      if (stop) break;
      throw new UsageError(`unrecognized arguments: ${tokens.slice(i).join(' ')}`);
    }
    const eq = token.indexOf('=');
    const flag = lookup(eq >= 0 && token.startsWith('--') ? token.slice(0, eq) : token, known);
    let value: string | undefined =
      eq >= 0 && token.startsWith('--') ? token.slice(eq + 1) : undefined;
    if (value === undefined) {
      const following = tokens[i + 1];
      if (following === undefined || (following.startsWith('-') && following !== '-'))
        throw new UsageError(`argument ${flag}: expected one argument`);
      value = following;
      i += 1;
    }
    values.set(flag, value);
    i += 1;
  }
  return { values, next: i };
}

export function parseArgs(argv: readonly string[]): Args {
  const tokens = argv.map((arg) => (arg === '--live-config' ? 'live-config' : arg));
  const top = readOptions(tokens, 0, ['--overlay'], true);
  const operation = tokens[top.next];
  const overlay = top.values.get('--overlay');
  if (operation === undefined || overlay === undefined) {
    const missing = [
      overlay === undefined ? '--overlay' : null,
      operation === undefined ? 'operation' : null,
    ]
      .filter((v) => v !== null)
      .join(', ');
    throw new UsageError(`the following arguments are required: ${missing}`);
  }
  const spec = OPERATIONS[operation];
  if (spec === undefined || !Object.prototype.hasOwnProperty.call(OPERATIONS, operation))
    throw new UsageError(
      `argument operation: invalid choice: ${pyStrRepr(operation)} (choose from ${Object.keys(OPERATIONS).map(pyStrRepr).join(', ')})`,
    );
  const rest = readOptions(
    tokens,
    top.next + 1,
    spec.map(([name]) => name),
    false,
  );
  const absent = spec.filter(([name, required]) => required && !rest.values.has(name));
  if (absent.length)
    throw new UsageError(
      `the following arguments are required: ${absent.map(([n]) => n).join(', ')}`,
    );
  const get = (name: string): string | undefined => rest.values.get(name);
  return {
    overlay,
    operation,
    unitsOutput: get('--units-output'),
    tag: operation === 'switch' || operation === 'prepare' ? (get('--tag') ?? null) : undefined,
    output: get('--output'),
    sha: get('--sha'),
    legacyRoot: get('--legacy-root'),
  };
}

const isOsError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';

/** `main()` plus the `SystemExit(str(exc))` wrapper; process I/O is returned, not performed. */
export async function main(argv: readonly string[], deps: MainDeps): Promise<MainResult> {
  const { env } = deps;
  try {
    let args: Args;
    try {
      args = parseArgs(argv);
    } catch (error) {
      if (error instanceof UsageError)
        return { exitCode: 2, stdout: '', stderr: `prepare-host.py: error: ${error.message}\n` };
      throw error;
    }
    const { overlay, raw } = await loadOverlay(args.overlay, env);
    const root = overlay.get('deploy_root') as string;
    if (args.operation === 'legacy-check') {
      await legacyCheck(legacyBundle(env, args.legacyRoot as string, overlay, raw), overlay);
    } else if (args.operation === 'switch') {
      await switchCheckout(
        hostBundle(env, root, overlay, raw),
        root,
        overlay,
        args.sha as string,
        args.tag ?? null,
      );
    } else if (args.operation === 'prepare') {
      const out = args.unitsOutput as string;
      await requireOutsideGit(out, env);
      if (!outside(out, root, pyResolve))
        throw new ValueError('rendered units must be outside checkout');
      await prepare(
        hostBundle(env, root, overlay, raw, { output: out }),
        root,
        overlay,
        args.tag ?? null,
      );
    } else if (args.operation === 'preview') {
      const out = args.output as string;
      const host = hostBundle(env, root, overlay, raw);
      await rootCheck(host, root, overlay);
      await requireOutsideGit(out, env);
      if (!outside(out, root, pyResolve))
        throw new ValueError('preview output must be outside checkout');
      await host.withTickLock(async () => {
        const data = await renderAt(host, overlay);
        await host.record(data, 'preview', []);
        await atomicBytes(`${posixStr(out)}/config.json`, data);
        await host.renderUnitsInto(`${posixStr(out)}/systemd`);
        await renderPlists(host.plistEffects(`${posixStr(out)}/launchd`, args.overlay), root);
      });
    } else {
      await liveRender(hostBundle(env, root, overlay, raw), root, overlay);
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ operation: args.operation, status: 'ok' }, null, 2)}\n`,
      stderr: `completed ${args.operation}; no units started\n`,
    };
  } catch (error) {
    if (
      error instanceof ValueError ||
      error instanceof CalledProcessError ||
      error instanceof BlockingIOError
    )
      return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    if (isOsError(error)) return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    throw error;
  }
}
