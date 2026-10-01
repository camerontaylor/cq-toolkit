// RS-13 backend adapters (B14): the launchers a certified backend is reached
// through.  An adapter owns exactly one mechanism for executing a command
// INSIDE an isolation boundary, and an availability check that reports the
// exact environmental blocker when the mechanism is not provisionable on this
// host.  An adapter that cannot run never certifies — certification is earned
// only by the live canaries in ./probe.js, never by declaring a launcher.
//
//   seatbelt  — macOS `sandbox-exec` with a generated deny-default profile
//               (importing bsd.sb is REQUIRED: deny-default profiles without
//               the BSD startup closure abort every child with SIGABRT).
//   bwrap     — Linux bubblewrap: bind-mount the workspace over a read-only
//               root, unshare the network namespace for model-only posture.
//   container — an OCI container (`docker run`) with no network, read-only
//               rootfs, no-new-privileges, and the workspace as the only
//               writable mount.
//   landlock  — needs a compiled helper binary that issues the landlock(2)
//               syscalls; absent a helper this backend records itself as not
//               provisioned (the D7 pattern), it is never silently "auto".
import { execFile as execFileCb } from 'node:child_process';
import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildSandboxLauncherEnv } from './index.js';
import type { SandboxBackend, SandboxNetwork } from './config.js';

const execFile = promisify(execFileCb);

/** A command to execute inside a backend boundary. */
export interface SandboxLaunchRequest {
  /** Absolute path of the directory the child may read and write. */
  workspace: string;
  /** argv executed inside the boundary; argv[0] must not begin with '-'. */
  argv: readonly string[];
  /** Parent environment the adapter scrubs (default: process.env). */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Env names copied past the scrub; CQ_* policy knob names are refused. */
  envPassthrough?: readonly string[];
  /** Requested egress posture; every shipped adapter is stricter than it. */
  network: SandboxNetwork;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/** What the backend child did. A launcher that could not spawn says so. */
export interface SandboxLaunchResult {
  /** The child exited 0. Never true for a spawn failure. */
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set only when the backend itself could not launch the child. */
  spawnError?: string;
}

/**
 * One RS-13 isolation mechanism. `available()` must report a concrete blocker
 * rather than a bare false, so a missing backend names itself.
 */
export interface SandboxBackendAdapter {
  readonly backend: SandboxBackend;
  /** Where a runnable workspace should be created on this platform. */
  workspaceParent(): string;
  /** Present AND usable: a binary that exists but cannot run is a blocker. */
  available(): Promise<{ available: boolean; blocker?: string }>;
  launch(request: SandboxLaunchRequest): Promise<SandboxLaunchResult>;
}

async function runChild(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    maxOutputChars: number;
  },
): Promise<SandboxLaunchResult> {
  const result: SandboxLaunchResult = {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
  };
  try {
    const { stdout, stderr } = await execFile(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    result.stdout = stdout.slice(0, options.maxOutputChars);
    result.stderr = stderr.slice(0, options.maxOutputChars);
    result.exitCode = 0;
    result.ok = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: string | number;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (err.code === 'ENOENT') {
      result.spawnError = `launcher not found: ${file}`;
    } else if (typeof err.code === 'number') {
      result.exitCode = err.code;
    }
    result.signal = err.signal ?? null;
    result.timedOut = err.killed === true;
    result.stdout = (err.stdout ?? '').slice(0, options.maxOutputChars);
    result.stderr = (err.stderr ?? err.message ?? '').slice(0, options.maxOutputChars);
    if (result.spawnError === undefined && result.exitCode === null && result.signal === null) {
      result.spawnError = err.message;
    }
  }
  return result;
}

/** Build the launcher child env from the parent env through the shared scrub. */
function launcherEnv(request: {
  parentEnv?: Readonly<Record<string, string | undefined>>;
  envPassthrough?: readonly string[];
}): Record<string, string> {
  return buildSandboxLauncherEnv(request.parentEnv ?? process.env, {
    envPassthrough: request.envPassthrough ?? [],
  });
}

// ---------------------------------------------------------------------------
// seatbelt — macOS sandbox-exec with a deny-default profile
// ---------------------------------------------------------------------------

export const SEATBELT_BIN = '/usr/bin/sandbox-exec';

/**
 * The seatbelt profile.  Deny-default is the only honest starting point, and
 * `bsd.sb` must be imported: on darwin 24 a deny-default profile without the
 * BSD startup closure SIGABRTs every child before main (observed on
 * darwin 24.6.0, sandbox-exec rc=134).  After the import, reads of the
 * read-only sealed system volume stay allowed for process startup and every
 * user-data zone is denied by path, so the workspace is the only
 * user-writable and user-readable surface.  The workspace rides in as the
 * `WS` profile PARAMETER (via `sandbox-exec -D`), never as interpolated
 * profile text: a workspace path is data and cannot rewrite the profile.
 * `model-only` denies all network operations — strictly stronger than the
 * requested posture, which the certification record states rather than
 * implying endpoint filtering.
 */
export function seatbeltProfile(network: SandboxNetwork): string {
  const denies = [
    '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))',
    ...(network === 'model-only' ? ['(deny network*)'] : []),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(import "bsd.sb")',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow mach-lookup)',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow file-read* (subpath "/"))',
    ...denies,
    '(allow file-read* file-write* (subpath (param "WS")))',
    '(allow file-write* (subpath "/dev/null"))',
    '',
  ].join('\n');
}

const SEATBELT_WORKSPACE_PARENT = '/private/var/tmp';

/** Symlink-honest: /tmp resolves into /private/tmp, a denied user-data zone. */
export function seatbeltAdapter(): SandboxBackendAdapter {
  const backend: SandboxBackend = 'seatbelt';
  return {
    backend,
    workspaceParent: () => SEATBELT_WORKSPACE_PARENT,
    async available() {
      if (process.platform !== 'darwin') {
        return { available: false, blocker: 'sandbox-exec exists only on darwin' };
      }
      try {
        await access(SEATBELT_BIN, constants.X_OK);
      } catch {
        return { available: false, blocker: `${SEATBELT_BIN} is not present/executable` };
      }
      // A present binary can still be unusable (hardened runtime policies);
      // availability means a trivial profile actually runs.
      const probe = await runChild(
        SEATBELT_BIN,
        ['-p', '(version 1)(allow default)', '/usr/bin/true'],
        {
          env: launcherEnv({}),
          timeoutMs: 10_000,
          maxOutputChars: 4_000,
        },
      );
      if (!probe.ok) {
        return {
          available: false,
          blocker: `sandbox-exec smoke run failed: ${probe.spawnError ?? (probe.stderr || `exit ${probe.exitCode}`)}`,
        };
      }
      return { available: true };
    },
    async launch(request) {
      const env = launcherEnv(request);
      // The child must never rely on the host per-user temp: it is a denied
      // user-data zone under this profile, so TMPDIR moves into the workspace.
      const childTmp = join(request.workspace, '.tmp');
      await mkdir(childTmp, { recursive: true });
      const profilePath = join(request.workspace, '.cq-seatbelt.sb');
      await writeFile(profilePath, seatbeltProfile(request.network));
      env['TMPDIR'] = childTmp;
      return runChild(
        SEATBELT_BIN,
        ['-D', `WS=${request.workspace}`, '-f', profilePath, '--', ...request.argv],
        {
          cwd: request.workspace,
          env,
          timeoutMs: request.timeoutMs ?? 30_000,
          maxOutputChars: request.maxOutputChars ?? 64 * 1024,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// bwrap — Linux bubblewrap
// ---------------------------------------------------------------------------

/**
 * The bubblewrap argv for one launch: the root tree is read-only, volatile
 * mounts (tmpfs over /tmp and over the host HOME, which the read-only root
 * bind would otherwise expose with its credentials) land BEFORE the workspace
 * bind so a workspace nested under either still shadows them, the workspace
 * is the only writable bind, and model-only posture unshares the whole
 * network namespace.  The child inherits the launcher process environment —
 * already the scrubbed launcher env — so env VALUES never appear in argv,
 * where any local user could read them.  Built as data so tests can assert
 * the boundary flags on any host; only a host that can actually run
 * bubblewrap can certify it (that proof lives in ./probe.js).
 */
export function bwrapArgv(
  workspace: string,
  network: SandboxNetwork,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): string[] {
  const home = env['HOME'];
  return [
    'bwrap',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    ...(home !== undefined && home !== '' ? ['--tmpfs', home] : []),
    '--bind',
    workspace,
    workspace,
    '--new-session',
    '--die-with-parent',
    ...(network === 'model-only' ? ['--unshare-net'] : []),
    '--',
    ...argv,
  ];
}

export function bwrapAdapter(): SandboxBackendAdapter {
  const backend: SandboxBackend = 'bwrap';
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      const probe = await runChild('bwrap', ['--version'], {
        env: launcherEnv({}),
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      });
      if (!probe.ok) {
        return {
          available: false,
          blocker: `bubblewrap unusable: ${probe.spawnError ?? (probe.stderr || `exit ${probe.exitCode}`)}`,
        };
      }
      return { available: true };
    },
    async launch(request) {
      const argv = bwrapArgv(
        request.workspace,
        request.network,
        launcherEnv(request),
        request.argv,
      );
      return runChild(argv[0]!, argv.slice(1), {
        cwd: request.workspace,
        env: launcherEnv(request),
        timeoutMs: request.timeoutMs ?? 30_000,
        maxOutputChars: request.maxOutputChars ?? 64 * 1024,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// container — OCI runtime (docker/podman CLI), strictest out of the box
// ---------------------------------------------------------------------------

export interface ContainerAdapterOptions {
  /** Image to run; a container backend without an image is not provisionable. */
  image: string;
  /** Container CLI binary (default `docker`). */
  command?: string;
}

/**
 * `--env NAME` (no value): the CLI reads each name from its own environment —
 * the scrubbed launcher env passed by `launch` — so env VALUES never appear
 * in argv, where any local user could read them.
 */

export function containerArgv(
  options: ContainerAdapterOptions,
  workspace: string,
  network: SandboxNetwork,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): string[] {
  return [
    options.command ?? 'docker',
    'run',
    '--rm',
    '--network',
    network === 'model-only' ? 'none' : 'bridge',
    '--read-only',
    '--security-opt',
    'no-new-privileges',
    '--volume',
    `${workspace}:${workspace}`,
    '--workdir',
    workspace,
    '--tmpfs',
    '/tmp',
    ...Object.entries(env).flatMap(([name]) => ['--env', name]),
    options.image,
    ...argv,
  ];
}

export function containerAdapter(options: ContainerAdapterOptions): SandboxBackendAdapter {
  const backend: SandboxBackend = 'container';
  const command = options.command ?? 'docker';
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      const probe = await runChild(command, ['info', '--format', 'ok'], {
        env: launcherEnv({}),
        timeoutMs: 15_000,
        maxOutputChars: 4_000,
      });
      if (!probe.ok) {
        return {
          available: false,
          blocker: `${command} daemon unreachable: ${probe.stderr.split('\n')[0] || probe.spawnError || `exit ${probe.exitCode}`}`,
        };
      }
      return { available: true };
    },
    async launch(request) {
      const env = launcherEnv(request);
      const argv = containerArgv(options, request.workspace, request.network, env, request.argv);
      return runChild(argv[0]!, argv.slice(1), {
        cwd: request.workspace,
        env,
        timeoutMs: request.timeoutMs ?? 30_000,
        maxOutputChars: request.maxOutputChars ?? 64 * 1024,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// landlock — not provisioned without a compiled helper (D7 pattern)
// ---------------------------------------------------------------------------

export interface LandlockAdapterOptions {
  /**
   * Path to a helper that issues landlock(2) rulesets and then execs its
   * remaining argv inside them.  The toolkit ships no such helper, so the
   * default is honestly "not provisioned", never silently selectable.
   */
  helperPath?: string;
}

export function landlockAdapter(options: LandlockAdapterOptions = {}): SandboxBackendAdapter {
  const backend: SandboxBackend = 'landlock';
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      if (options.helperPath === undefined) {
        return {
          available: false,
          blocker:
            'no landlock helper binary provided; landlock(2) needs a compiled ruleset launcher the toolkit does not ship',
        };
      }
      const probe = await runChild(options.helperPath, ['--version'], {
        env: launcherEnv({}),
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      });
      if (!probe.ok) {
        return {
          available: false,
          blocker: `landlock helper unusable: ${probe.spawnError ?? (probe.stderr || `exit ${probe.exitCode}`)}`,
        };
      }
      return { available: true };
    },
    async launch(request) {
      if (options.helperPath === undefined) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: 'landlock is not provisioned: no helper binary',
        };
      }
      return runChild(
        options.helperPath,
        ['--workspace', request.workspace, '--network', request.network, '--', ...request.argv],
        {
          cwd: request.workspace,
          env: launcherEnv(request),
          timeoutMs: request.timeoutMs ?? 30_000,
          maxOutputChars: request.maxOutputChars ?? 64 * 1024,
        },
      );
    },
  };
}

/** The RS-13 candidates in the platform's `auto` selection order. */
export function adaptersForPlatform(platform: NodeJS.Platform): SandboxBackendAdapter[] {
  if (platform === 'darwin') return [seatbeltAdapter(), containerAdapter({ image: 'cq-sandbox' })];
  if (platform === 'linux')
    return [landlockAdapter(), bwrapAdapter(), containerAdapter({ image: 'cq-sandbox' })];
  return [];
}
