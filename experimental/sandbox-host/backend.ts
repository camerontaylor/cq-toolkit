// Host-specific sandbox launchers. This module is intentionally outside the
// shipped core package; local host behavior remains governed by sandbox/config.
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { containerAdapter, landlockAdapter } from '../../src/sandbox/backend.js';
import {
  launcherEnv,
  launcherInsideWorkspace,
  resolveLauncher,
  runChild,
} from '../../src/sandbox/launcher.js';
import type { SandboxBackend, SandboxNetwork } from '../../src/sandbox/config.js';
import type { SandboxBackendAdapter, SandboxLaunchResult } from '../../src/sandbox/launcher.js';

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
 * Real enforcement is exercised by the macOS backend/probe tests and the
 * seatbelt-live certification canaries. A wrong SBPL rule (e.g. a bad
 * `(remote ip ...)` form) surfaces as a child
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
    // NO blanket `(allow mach-lookup)` (crq delta review): it opened every
    // global Mach service to the child — a confined /usr/bin/pbpaste read the
    // host clipboard under it (observed on darwin 24.6.0).  bsd.sb grants the
    // startup services, and every canary child runs without the blanket rule.
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
      // Shell lookup must agree with the profile's executable trees. A host
      // PATH preferring Homebrew/GNU tools otherwise selects a denied binary
      // for an ordinary command such as `cat`, even though /bin/cat is allowed.
      // Explicit commands outside these trees remain denied by the profile.
      env['PATH'] = '/usr/bin:/bin:/sbin:/usr/libexec';
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
      const bwrapInside = launcherInsideWorkspace(launcher, request.workspace);
      if (bwrapInside !== undefined) return bwrapInside;
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

/** Candidate ordering used only by the experimental host certification probe. */
export function adaptersForPlatform(platform: NodeJS.Platform): SandboxBackendAdapter[] {
  if (platform === 'darwin') return [seatbeltAdapter(), containerAdapter()];
  if (platform === 'linux') return [landlockAdapter(), bwrapAdapter(), containerAdapter()];
  return [];
}
