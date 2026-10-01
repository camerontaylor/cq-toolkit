// RS-13 backend adapters (B14): the launchers a certified backend is reached
// through.  An adapter owns exactly one mechanism for executing a command
// INSIDE an isolation boundary, and an availability check that reports the
// exact environmental blocker when the mechanism is not provisionable on this
// host.  An adapter that cannot run never certifies — certification is earned
// only by the live canaries in ./probe.js, never by declaring a launcher.
//
//   seatbelt  — macOS `sandbox-exec` with a generated deny-default profile
//               (importing bsd.sb is REQUIRED: deny-default profiles without
//               the BSD startup closure abort every child with SIGABRT).  File
//               reads use a NARROW runtime allowlist — the Sol audit rejected
//               the earlier broad `(subpath "/")` allow with narrow denies,
//               which left sibling host paths (e.g. other /private/var/tmp
//               trees) readable.  LIVE STATUS: this narrow-allow profile has
//               NOT yet executed a child on any host (the broad-root variant
//               did — a limited 6/6 canary observation, retracted as
//               certification by audit); final-head live evidence is a gate
//               of the fresh protocol sequence.
//   bwrap     — Linux bubblewrap: minimal read-only binds of the OS runtime
//               trees (no host-root bind — same audit finding), unshare the
//               network namespace for model-only posture.
//   container — an OCI container (`docker run`) with no network, read-only
//               rootfs, no-new-privileges, all capabilities dropped, a
//               non-root UID, and the workspace as the only writable mount.
//   landlock  — needs a compiled helper binary that issues the landlock(2)
//               syscalls; absent a helper this backend records itself as not
//               provisioned (the D7 pattern), it is never silently "auto".
import { execFile as execFileCb } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  /**
   * Loopback port of the local model proxy, for `model-only` composed with a
   * proxy: the ONLY egress the backend permits.  A backend that cannot compose
   * a proxy refuses the request outright rather than silently denying all.
   */
  proxyPort?: number;
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
  /**
   * Whether model-only posture can compose a loopback proxy (request
   * `proxyPort`).  A backend without this capability is UNCERTIFIABLE for a
   * proxy-composed posture: the probe records the blocker and certifies
   * nothing — the posture fails closed.
   */
  readonly supportsProxyModelOnly?: boolean;
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
 * darwin 24.6.0, sandbox-exec rc=134).
 *
 * File reads are a NARROW runtime allowlist (Sol audit, backend.ts:156): the
 * sealed system volume trees a child needs to exec and load — and NOTHING
 * else.  The earlier broad `(allow file-read* (subpath "/"))` with narrow
 * user-data denies left sibling host paths readable and was rejected; this
 * profile never grants a whole-volume read, so a sentinel beside the
 * workspace (same parent tree) is unreadable by construction.
 *
 * The workspace rides in as the `WS` profile PARAMETER (via
 * `sandbox-exec -D`), never as interpolated profile text: a workspace path is
 * data and cannot rewrite the profile.
 *
 * Egress: `model-only` with `proxyPort` permits outbound connections to that
 * ONE loopback port — the local model proxy — and nothing else; `model-only`
 * without a proxy permits no network at all.  `allow` permits everything.
 * No rule implies denial under `(deny default)`, and seatbelt `deny` is
 * sticky, so the composition stays minimal.
 *
 * LIVE STATUS: the broad-root variant of this profile executed children on
 * darwin 24.6.0 (limited 6/6 canary observation, audit-retracted as
 * certification); THIS narrow-allow variant has not yet run on any host —
 * live evidence at final head is a gate of the fresh protocol sequence.  A
 * wrong SBPL rule (e.g. a bad `(remote ip ...)` form) surfaces as a child
 * launch failure, which the probe records as a control failure — it can
 * never pass by accident.
 */
export function seatbeltProfile(network: SandboxNetwork, proxyPort?: number): string {
  // Process execution is narrowed to the accepted P7 trial's trees: /usr/bin,
  // /bin, /sbin, /usr/libexec.  /usr/local/* is deliberately ABSENT (the
  // delta review's attack target — e.g. /usr/local/bin/docker stays denied),
  // and the live local-prefix-exec canary attacks exactly that surface.
  const execTrees = ['"/usr/bin"', '"/bin"', '"/sbin"', '"/usr/libexec"']
    .map((tree) => `(subpath ${tree})`)
    .join(' ');
  const networkRules =
    network === 'allow'
      ? ['(allow network*)']
      : proxyPort !== undefined
        ? [`(allow network-outbound (remote ip "127.0.0.1:${proxyPort}"))`]
        : [];
  return [
    '(version 1)',
    '(deny default)',
    '(import "bsd.sb")',
    `(allow process-exec* ${execTrees})`,
    '(allow process-fork)',
    '(allow mach-lookup)',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow file-read*',
    '  (subpath "/bin")',
    '  (subpath "/sbin")',
    '  (subpath "/usr/bin")',
    '  (subpath "/usr/sbin")',
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/share")',
    '  (subpath "/System")',
    '  (subpath "/Library/Apple")',
    '  (subpath "/private/var/db/dyld")',
    '  (subpath "/dev"))',
    ...networkRules,
    '(allow file-read* file-write* (subpath (param "WS")))',
    '(allow file-write* (subpath "/dev/null"))',
    '',
  ].join('\n');
}

const SEATBELT_WORKSPACE_PARENT = '/private/var/tmp';

/** Symlink-honest: /tmp resolves into /private/tmp, outside the read allowlist. */
export function seatbeltAdapter(): SandboxBackendAdapter {
  const backend: SandboxBackend = 'seatbelt';
  return {
    backend,
    workspaceParent: () => SEATBELT_WORKSPACE_PARENT,
    supportsProxyModelOnly: true,
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
      // The child must never rely on the host per-user temp: it sits outside
      // this profile's read allowlist, so TMPDIR moves into the workspace.
      const childTmp = join(request.workspace, '.tmp');
      await mkdir(childTmp, { recursive: true });
      env['TMPDIR'] = childTmp;
      // The policy NEVER lives in the model-writable workspace (Sol review:
      // a child could plant a symlink at the policy path or race the write
      // with a permissive replacement before sandbox-exec -f reads it).  It
      // is written to a fresh 0700 parent-private directory — created by
      // mkdtemp, so no pre-planted path can exist — with 0600 on the file,
      // and the directory is destroyed when the launch ends.  A confined
      // child cannot reach it, and the next launch compiles a fresh profile.
      const profileDir = await mkdtemp(join(tmpdir(), 'cq-sb-prof-'));
      try {
        const profilePath = join(profileDir, 'policy.sb');
        await writeFile(profilePath, seatbeltProfile(request.network, request.proxyPort), {
          mode: 0o600,
        });
        return await runChild(
          SEATBELT_BIN,
          ['-D', `WS=${request.workspace}`, '-f', profilePath, '--', ...request.argv],
          {
            cwd: request.workspace,
            env,
            timeoutMs: request.timeoutMs ?? 30_000,
            maxOutputChars: request.maxOutputChars ?? 64 * 1024,
          },
        );
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// bwrap — Linux bubblewrap
// ---------------------------------------------------------------------------

/**
 * The bubblewrap argv for one launch.  The host root is NOT bound (Sol audit,
 * backend.ts:261 — a root ro-bind exposes host reads): only the OS runtime
 * trees a child needs are bound read-only (`/usr` required; `/bin`, `/sbin`,
 * `/lib`, `/lib64` with `-try`, which skip absent trees).  Host `/etc` is NOT
 * bound (delta review): the namespace has no /etc at all, so host
 * configuration never enters; tools that require it may fail, which the
 * workspace control surfaces.  Volatile
 * paths are masked (`/tmp`, and `$HOME` so host credentials are never in the
 * mount namespace), and the workspace is the only writable bind, placed AFTER
 * the masks so a workspace nested under either still shadows them.  Model-only
 * posture unshares the whole network namespace — which necessarily denies
 * loopback too, so bwrap cannot compose a loopback proxy; a proxyPort request
 * is refused, never silently downgraded.  The child inherits the launcher
 * process environment — already the scrubbed launcher env — so env VALUES
 * never appear in argv, where any local user could read them.  Built as data
 * so tests can assert the boundary flags on any host; only a host that can
 * actually run bubblewrap can certify it (that proof lives in ./probe.js).
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
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/sbin',
    '/sbin',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
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
      if (request.proxyPort !== undefined) {
        // --unshare-net denies loopback with the rest of the network; there is
        // no proxy composition.  Refuse rather than silently downgrade.
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError:
            'bwrap cannot compose a loopback proxy under model-only (--unshare-net denies loopback); proxyPort is unsupported',
        };
      }
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
  /**
   * Non-root UID:GID the container runs as (Sol audit, backend.ts:344).
   * Fixed numeric so no image can silently grant root; override only with
   * another NON-root identity.  A workspace whose permissions exclude this
   * UID fails the workspace control and is not certifiable.
   */
  user?: string;
}

/**
 * Validated at construction (delta review P2): a `--user` override naming
 * root — `0`, `0:0`, `0:anything` — or a non-numeric identity is refused
 * outright, so the non-root claim cannot be silently defeated by options.
 */
function validatedContainerUser(user: string | undefined): string {
  const requested = user ?? '65532:65532';
  const match = /^(\d{1,10})(?::(\d{1,10}))?$/.exec(requested);
  if (match === null) {
    throw new Error(`sandbox: container --user '${requested}' must be numeric UID[:GID]`);
  }
  // Numeric parse, not string equality: `00`, `000:1000` and `1000:00` are
  // all root-aliasing forms and must be refused (delta review).
  const uid = Number(match[1]);
  const gid = match[2] === undefined ? uid : Number(match[2]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new Error(`sandbox: container --user '${requested}' is out of range`);
  }
  if (uid === 0 || gid === 0) {
    throw new Error(
      `sandbox: container --user '${requested}' is refused; the container boundary is certified non-root`,
    );
  }
  return requested;
}

/**
 * `--cap-drop ALL` and a non-root `--user` are part of the boundary, not
 * optional hardening: the canaries certify the launcher exactly as built
 * here.  `--env NAME` (no value) makes the CLI read each name from its own
 * environment — the scrubbed launcher env passed by `launch` — so env VALUES
 * never appear in argv, where any local user could read them.
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
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    validatedContainerUser(options.user),
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
      if (request.proxyPort !== undefined) {
        // --network none denies loopback with the rest; no proxy composition.
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError:
            'container cannot compose a loopback proxy under model-only (--network none); proxyPort is unsupported',
        };
      }
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
