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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { buildSandboxLauncherEnv } from './index.js';
import type { SandboxBackend, SandboxNetwork } from './config.js';

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

/**
 * Run a launcher child to settlement and classify what happened.  The child
 * gets its OWN PROCESS GROUP (final-head review): on timeout the group is
 * SIGKILLed, and after the direct child exits the group is swept once more —
 * an execFile-based predecessor killed only the direct child, so a background
 * grandchild with inherited stdio pipes survived the launch (and kept the
 * launch's result from settling until it happened to exit).  `ok` means the
 * child exited 0; a launcher that could not spawn says so via `spawnError`.
 */
function runChild(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    maxOutputChars: number;
  },
): Promise<SandboxLaunchResult> {
  return new Promise((resolve) => {
    const result: SandboxLaunchResult = {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
    // Hard capture cap matching the previous execFile maxBuffer (16 MiB);
    // overflow kills the child group and is classified as a timeout.
    const captureCap = 16 * 1024 * 1024;
    let outBytes = 0;
    let errBytes = 0;
    let out = '';
    let err = '';
    let overflowed = false;
    let spawnErrorMessage: string | undefined;
    let spawnErrored = false;
    let finished = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      result.spawnError = (error as Error).message;
      resolve(result);
      return;
    }
    // Group kill is PID-scoped to THIS child's own group.  Residual race,
    // documented (delta review): after the child exits AND its group has
    // fully vanished, the numeric group ID could in principle be recycled by
    // an unrelated group before the sweep below — then the sweep would signal
    // that unrelated group.  Existing descendants PRESERVE the group, so the
    // sweep always reaches them; only the vanished-group case is exposed, and
    // the window is a single scheduling step.  A /proc-scoped descendant walk
    // would close it at the cost of portability; not taken.
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone — nothing to sweep.
      }
    };
    const settle = (): void => {
      // Sweep the group the moment the DIRECT child is gone: descendants
      // holding the stdio pipes would otherwise delay settlement until the
      // timeout (delta review).  Spawn failures have no group to sweep.
      if (!spawnErrored && !settled) {
        settled = true;
        killGroup('SIGKILL');
      }
    };
    let settled = false;
    const timer = setTimeout(() => {
      result.timedOut = true;
      killGroup('SIGKILL');
    }, options.timeoutMs);
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle();
      if (overflowed) result.timedOut = true;
      if (spawnErrorMessage !== undefined) result.spawnError = spawnErrorMessage;
      result.stdout = out.slice(0, options.maxOutputChars);
      result.stderr = (err !== '' ? err : (spawnErrorMessage ?? '')).slice(
        0,
        options.maxOutputChars,
      );
      resolve(result);
    };
    const capture = (current: string, chunk: Buffer, currentBytes: number): string => {
      if (currentBytes >= captureCap) {
        overflowed = true;
        return current;
      }
      if (currentBytes + chunk.byteLength > captureCap) {
        overflowed = true;
        return current + chunk.toString('utf8', 0, captureCap - currentBytes);
      }
      return current + chunk.toString('utf8');
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnErrored = true;
      spawnErrorMessage = error.code === 'ENOENT' ? `launcher not found: ${file}` : error.message;
      settle();
      finish();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      out = capture(out, chunk, outBytes);
      outBytes = Math.min(outBytes + chunk.byteLength, captureCap);
      // Overflow must not be survivable (delta review): kill the group now so
      // a later exit 0 can never be classified ok after the cap was blown.
      if (overflowed) {
        result.timedOut = true;
        killGroup('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = capture(err, chunk, errBytes);
      errBytes = Math.min(errBytes + chunk.byteLength, captureCap);
      if (overflowed) {
        result.timedOut = true;
        killGroup('SIGKILL');
      }
    });
    child.on('exit', () => settle());
    child.on('close', (code, signal) => {
      result.exitCode = code;
      result.signal = signal ?? null;
      if (code === 0 && signal === null && !result.timedOut && !overflowed) result.ok = true;
      finish();
    });
  });
}

/**
 * Resolve a launcher name to an ABSOLUTE path ONCE per adapter
 * (final-head review): the certification probe and every later launch must
 * execute the SAME binary even when a request supplies a parentEnv whose PATH
 * differs — a PATH pointing into the workspace could otherwise select a
 * planted launcher while adapter identity still matches the receipt.
 * Resolution deliberately uses the ADAPTER process environment (the env the
 * probe's availability check ran under), never the per-request parent env.
 * Relative names (with or without slashes) are anchored to the ADAPTER
 * process cwd; PATH candidates are absolutized the same way, so a relative
 * PATH entry cannot turn into a cwd-dependent launcher.  `undefined` when
 * nothing absolute can be bound: callers fail closed (availability reports
 * the blocker; launch refuses) instead of falling back to a per-invocation
 * PATH lookup that would undo the binding.
 */
function resolveLauncher(name: string): string | undefined {
  const absolute = (candidate: string): string => resolve(candidate);
  if (name.includes('/')) return absolute(name);
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = absolute(join(dir, name));
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return undefined;
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
/**
 * Runtime validation for the proxy port (Sol exact-head audit): the port is
 * interpolated into an SBPL rule, so TypeScript's `number` annotation is not
 * a guard — a string arriving through an untyped boundary could inject
 * policy syntax.  Only a real integer in [1, 65535] passes.
 */
function validatedProxyPort(port: number): number {
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `sandbox: proxyPort must be an integer between 1 and 65535, got '${String(port)}'`,
    );
  }
  return port;
}

export function seatbeltProfile(network: SandboxNetwork, proxyPort?: number): string {
  // Process execution is narrowed to the accepted P7 trial's trees: /usr/bin,
  // /bin, /sbin, /usr/libexec.  /usr/local/* is deliberately ABSENT (the
  // delta review's attack target — e.g. /usr/local/bin/docker stays denied),
  // and the live local-prefix-exec canary attacks exactly that surface.
  const execTrees = ['"/usr/bin"', '"/bin"', '"/sbin"', '"/usr/libexec"']
    .map((tree) => `(subpath ${tree})`)
    .join(' ');
  const port = proxyPort === undefined ? undefined : validatedProxyPort(proxyPort);
  const networkRules =
    network === 'allow'
      ? ['(allow network*)']
      : port !== undefined
        ? // SBPL rejects numeric addresses here ("host must be * or localhost
          // in network address" — surfaced by the first live execution of
          // this rule at final head); `localhost` is the accepted loopback
          // spelling.
          [`(allow network-outbound (remote ip "localhost:${port}"))`]
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
/**
 * Canonical, env-INDEPENDENT parent for compiled sandbox policies (Sol final
 * audit): os.tmpdir() honors $TMPDIR, and an inherited TMPDIR pointing inside
 * the model-writable workspace would put the policy within the same-uid
 * child's reach.  /private/var/tmp is fixed at build time instead.
 */
const SEATBELT_POLICY_PARENT = '/private/var/tmp';

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
        accessSync(SEATBELT_BIN, constants.X_OK);
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
      // Canonicalize FIRST — before any workspace mutation (Sol recheck):
      // containment, `-D WS`, cwd, and the child's TMPDIR all bind THIS one
      // resolved path, so a symlink retarget after the check cannot reopen
      // policy-parent inclusion.  An unresolvable workspace fails closed.
      let workspace: string;
      try {
        workspace = await realpath(request.workspace);
      } catch (error) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: `workspace path is not canonicalizable: ${(error as Error).message}`,
        };
      }
      const refusal = (message: string): SandboxLaunchResult => ({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: message,
      });
      const env = launcherEnv(request);
      // The policy NEVER lives in the model-writable workspace, and its
      // parent is CANONICAL — never env-derived (Sol final audit: an
      // inherited TMPDIR pointing inside the workspace would defeat any
      // 0700 directory, because the confined child is the SAME uid).  It is
      // written to a fresh 0700 directory under /private/var/tmp — created
      // by mkdtemp, so no pre-planted path can exist — with 0600 on the
      // file, and the directory is destroyed when the launch ends.  A
      // confined child cannot read, list, or write outside the workspace,
      // and the next launch compiles a fresh profile.
      const profileDir = await mkdtemp(join(SEATBELT_POLICY_PARENT, 'cq-sb-prof-'));
      try {
        // Containment guard BEFORE any workspace mutation (Sol recheck): a
        // workspace that resolves onto the trusted policy parent is refused
        // without so much as creating <workspace>/.tmp.
        const resolvedPolicyDir = await realpath(profileDir);
        if (!relative(workspace, resolvedPolicyDir).startsWith('..')) {
          return refusal(
            'requested workspace contains the trusted policy parent; refusing to place the sandbox policy inside it',
          );
        }
        // Race hardening: the workspace must STILL resolve to the same
        // canonical directory immediately before exec — a symlink retargeted
        // between canonicalization and use is refused, never followed.
        const retargetCheck = await realpath(request.workspace).catch(() => undefined);
        if (retargetCheck !== workspace) {
          return refusal(
            'workspace retargeted during launch; the certified canonical binding is stale',
          );
        }
        // Only now mutate the (contained) workspace: the child must never
        // rely on the host per-user temp — it sits outside the read
        // allowlist — so TMPDIR moves into the workspace.
        const childTmp = join(workspace, '.tmp');
        await mkdir(childTmp, { recursive: true });
        env['TMPDIR'] = childTmp;
        const profilePath = join(profileDir, 'policy.sb');
        await writeFile(profilePath, seatbeltProfile(request.network, request.proxyPort), {
          mode: 0o600,
        });
        return await runChild(
          SEATBELT_BIN,
          ['-D', `WS=${workspace}`, '-f', profilePath, '--', ...request.argv],
          {
            cwd: workspace,
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
 * `/lib`, `/lib64` with `-try`, which skip absent trees).  Because
 * `/usr/local` lives under `/usr` on Linux, it is MASKED with an empty tmpfs
 * immediately after the `/usr` bind — structurally, so host files created
 * there after certification are invisible too (Sol final audit).  Host `/etc`
 * is NOT
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
    // /usr/local lives UNDER /usr on Linux, so the ro-bind would expose it —
    // including files created after certification (Sol final audit).  Mask it
    // with an empty tmpfs immediately after the /usr bind.
    '--tmpfs',
    '/usr/local',
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
    // A host PID must never be reachable through /proc/<pid>/root or fd.
    '--unshare-pid',
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
  // Fixed for the adapter's lifetime (final-head review): probes and launches
  // execute the SAME binary regardless of any request's parentEnv PATH.
  // Unresolvable = fail closed (never a per-invocation PATH fallback).
  const launcher = resolveLauncher('bwrap');
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      if (launcher === undefined) {
        return { available: false, blocker: 'bwrap not found on the adapter PATH' };
      }
      const probe = await runChild(launcher, ['--version'], {
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
      if (launcher === undefined) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: 'bwrap launcher was not resolved at construction; refusing a PATH fallback',
        };
      }
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
      return runChild(launcher, argv.slice(1), {
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
  // Snapshot and freeze EVERY launch-relevant option at construction (Sol
  // final-head review): the adapter must never read caller-owned mutable
  // state after certification, or mutating options.command/image/user would
  // change the executable while adapter.launch stays identity-fixed and the
  // receipt cannot see it.  Validation also happens HERE, so a root --user
  // is refused before any probe, not just at launch.
  const resolved = Object.freeze({
    command: options.command ?? 'docker',
    image: options.image,
    user: validatedContainerUser(options.user),
  });
  // The CLI binary is fixed at construction (final-head review): a bare name
  // is resolved to its absolute path ONCE here, so a launch request carrying
  // a parentEnv with a different PATH — one pointing into the workspace —
  // cannot select a different executable after certification.
  const launcher = resolveLauncher(resolved.command);
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      if (launcher === undefined) {
        return {
          available: false,
          blocker: `${resolved.command} not found on the adapter PATH`,
        };
      }
      const probe = await runChild(launcher, ['info', '--format', 'ok'], {
        env: launcherEnv({}),
        timeoutMs: 15_000,
        maxOutputChars: 4_000,
      });
      if (!probe.ok) {
        return {
          available: false,
          blocker: `${resolved.command} daemon unreachable: ${probe.stderr.split('\n')[0] || probe.spawnError || `exit ${probe.exitCode}`}`,
        };
      }
      return { available: true };
    },
    async launch(request) {
      if (launcher === undefined) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: `${resolved.command} launcher was not resolved at construction; refusing a PATH fallback`,
        };
      }
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
      // Create without executing first: a timed-out `docker run` can leave
      // its daemon-owned child alive after the CLI dies. Only start an ID
      // returned by a completed create, and forcibly remove that exact ID
      // after EVERY attach outcome (including timeout/output overflow).
      const name = `cq-sandbox-${randomUUID()}`;
      const argv = containerArgv(resolved, request.workspace, request.network, env, request.argv);
      const childOptions = {
        cwd: request.workspace,
        env,
        timeoutMs: request.timeoutMs ?? 30_000,
        maxOutputChars: request.maxOutputChars ?? 64 * 1024,
      };
      const createArgs = argv.slice(3); // omit --rm
      let identity = name;
      let outcome: SandboxLaunchResult = {
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: 'container launch did not complete',
      };
      try {
        const created = await runChild(launcher, ['create', '--name', name, ...createArgs], {
          ...childOptions,
          maxOutputChars: 4_000,
        });
        const id = created.stdout.trim();
        if (!created.ok) {
          outcome = created;
        } else if (!/^[a-f0-9]{64}$/.test(id)) {
          outcome = {
            ...created,
            ok: false,
            spawnError:
              'container create returned no valid immutable container ID; refusing to start',
          };
        } else {
          identity = id;
          outcome = await runChild(launcher, ['start', '--attach', id], childOptions);
          if (outcome.ok) {
            // CLI success is not the container's exit status. Verify the
            // daemon reports a stopped child and read its actual exit code.
            const state = await runChild(
              launcher,
              ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', id],
              { ...childOptions, timeoutMs: 15_000, maxOutputChars: 4_000 },
            );
            const stopped = /^false (\d+)$/.exec(state.stdout.trim());
            if (!state.ok || stopped === null) {
              outcome = {
                ...outcome,
                ok: false,
                spawnError: 'container child exit could not be confirmed by daemon inspection',
              };
            } else {
              const exitCode = Number(stopped[1]);
              outcome = { ...outcome, ok: exitCode === 0, exitCode };
            }
          }
        }
      } finally {
        // A completed rm --force proves the known container is gone. Never
        // mistake killing the attach CLI for settlement of its descendants.
        const removed = await runChild(launcher, ['rm', '--force', identity], {
          ...childOptions,
          timeoutMs: 15_000,
          maxOutputChars: 4_000,
        });
        if (!removed.ok) {
          outcome = {
            ok: false,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: removed.stderr,
            timedOut: outcome.timedOut || removed.timedOut,
            spawnError: `container cleanup unconfirmed for ${identity}: ${removed.spawnError ?? removed.stderr}`,
          };
        }
      }
      return outcome;
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
  // Snapshot AND resolve at construction (Sol final-head review):
  // options.helperPath is caller-owned mutable state — reading it at launch
  // time would let a post-certification mutation swap the helper that
  // executes while adapter.launch stays identity-fixed.  A bare name is
  // resolved to its absolute path once, for the same PATH-identity reason as
  // the other launchers.
  const helperPath =
    options.helperPath === undefined ? undefined : resolveLauncher(options.helperPath);
  return {
    backend,
    workspaceParent: tmpdir,
    async available() {
      if (helperPath === undefined) {
        return {
          available: false,
          blocker:
            options.helperPath === undefined
              ? 'no landlock helper binary provided; landlock(2) needs a compiled ruleset launcher the toolkit does not ship'
              : `landlock helper '${options.helperPath}' could not be resolved to an absolute path`,
        };
      }
      const probe = await runChild(helperPath, ['--version'], {
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
      if (helperPath === undefined) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError:
            options.helperPath === undefined
              ? 'landlock is not provisioned: no helper binary'
              : `landlock helper '${options.helperPath}' was not resolved at construction; refusing a PATH fallback`,
        };
      }
      return runChild(
        helperPath,
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
