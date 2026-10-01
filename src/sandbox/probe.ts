// The RS-13 live boundary probe (B14): a backend is certified ONLY when real
// canaries executed inside its launcher demonstrate the boundary, and every
// positive control proves the canary ran for real.  There is no synthetic
// pass: a launcher that blocks everything fails its controls and stays
// uncertified; a backend that cannot run at all records the exact
// environmental blocker and stays uncertified; an inconclusive canary
// (control failed, canary binary never executed) also refuses certification —
// doubt fails closed.
//
// Canary coverage (Sol audit, probe.ts:208): escape attempts probe the parent
// temp tree, a SIBLING directory beside the workspace (inside the broad-root
// allow surface the audit rejected — this canary is what bites that gap), a
// SYMLINK from inside the workspace to that sibling, and a NESTED child (a
// shell spawning a grandchild) so the boundary is proven for descendants, not
// just the direct child.  Network coverage is posture-aware: loopback to a
// live listener, an EXTERNAL connect to a public resolver (armed only when
// the bare host demonstrably reaches it — an offline host cannot certify
// egress denial and fails closed), and for the proxy-composed model-only
// posture, egress through the ONE permitted local proxy port plus denial of
// every other port.
//
// `certifyBackends` results carry a probe-internal receipt (a module-private
// WeakSet).  `launchCertified` refuses any certification object it did not
// produce, so a caller-forged list — however well shaped — cannot authorize a
// launch (Sol audit, probe.ts:417).
//
// The certified list this module emits is the ONLY intended source for
// `resolveSandboxConfig({ certifiedBackends })`; `certifiedBackendsOf` types
// that handoff so no caller can name a backend the probe never ran.
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { connect, createServer, type AddressInfo } from 'node:net';

import {
  adaptersForPlatform,
  type SandboxBackendAdapter,
  type SandboxLaunchResult,
} from './backend.js';
import type { SandboxBackend, SandboxNetwork } from './config.js';

const execFile = promisify(execFileCb);

export type CanaryId =
  | 'workspace-control'
  | 'read-escape'
  | 'read-escape-sibling'
  | 'symlink-escape'
  | 'nested-child-escape'
  | 'write-escape'
  | 'credential-env'
  | 'credential-file'
  | 'network-loopback'
  | 'network-proxy'
  | 'network-external';

/**
 * What the probe DEMONSTRATED about egress — recorded per backend and per
 * certification.  `none` is the strictest demonstration (no network at all);
 * `proxy-loopback` means exactly one loopback port (the local model proxy)
 * passed and every other egress target was refused; `allow` means egress
 * passed through.
 */
export type NetworkDemonstrated = 'none' | 'proxy-loopback' | 'allow';

/** `inconclusive` means a control failed: the canary result carries no verdict. */
export interface CanaryOutcome {
  id: CanaryId;
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Executed evidence: exit codes, stderr heads — not claims. */
  detail: string;
}

export interface BackendProbeRecord {
  backend: SandboxBackend;
  platform: NodeJS.Platform;
  /** Posture the canaries executed under. */
  network: SandboxNetwork;
  networkDemonstrated: NetworkDemonstrated;
  runnable: boolean;
  certified: boolean;
  /** The exact environmental blocker when not runnable or not certified. */
  blocker?: string;
  canaries: CanaryOutcome[];
}

export interface SandboxCertification {
  platform: NodeJS.Platform;
  probedAt: string;
  network: SandboxNetwork;
  networkDemonstrated: NetworkDemonstrated;
  records: BackendProbeRecord[];
  certified: readonly SandboxBackend[];
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Adapters to probe; defaults to the platform's `auto` candidates. */
  adapters?: readonly SandboxBackendAdapter[];
  network?: SandboxNetwork;
  /**
   * Compose model-only with a local proxy: the probe stands in for the proxy
   * on a loopback port, grants ONLY that port, and demands both legs (proxy
   * connect succeeds, every other egress refused).  Backends that cannot
   * compose a proxy are uncertifiable under this posture and fail closed.
   */
  modelProxy?: boolean;
  timeoutMs?: number;
}

/**
 * Receipt for certifications this module produced.  Plain data can be forged;
 * module identity cannot be copied across a boundary a caller controls.
 */
const probeEarned = new WeakSet<object>();

function assertProbeEarned(certification: SandboxCertification): void {
  if (!probeEarned.has(certification)) {
    throw new Error(
      'sandbox: certification was not produced by the RS-13 probe; a caller-forged certification object cannot authorize a launch',
    );
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

function detail(result: {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: string;
}): string {
  const state =
    result.spawnError ??
    (result.ok
      ? 'exit 0'
      : `exit ${result.exitCode ?? '?'}${result.signal ? ` signal ${result.signal}` : ''}`);
  const err = firstLine(result.stderr);
  return err === '' ? state : `${state}: ${err}`;
}

/**
 * True only when the requested binary actually RAN: a spawn failure, a
 * timeout, or a 126/127 exit (could not exec / not found) means the canary's
 * command never executed, so a nonzero exit is NOT evidence of a boundary —
 * it is an inconclusive answer.  A genuine denial exits 1 with an
 * "Operation not permitted"-class error.
 */
function executed(r: { spawnError?: string; timedOut: boolean; exitCode: number | null }): boolean {
  return r.spawnError === undefined && !r.timedOut && r.exitCode !== 126 && r.exitCode !== 127;
}

/** A read/touch denial verdict for one target: fail / inconclusive / pass. */
function denialOutcome(id: CanaryId, result: SandboxLaunchResult, what: string): CanaryOutcome {
  if (result.ok) return { id, verdict: 'fail', detail: what };
  if (!executed(result))
    return { id, verdict: 'inconclusive', detail: `canary never ran: ${detail(result)}` };
  return { id, verdict: 'pass', detail: detail(result) };
}

/** Executed on the bare host — the control that proves a canary CAN fire. */
async function hostExec(
  argv: readonly string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    await execFile(argv[0]!, argv.slice(1), { env, timeout: 10_000 });
    return { ok: true, stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; message?: string };
    return { ok: false, stderr: firstLine(err.stderr ?? err.message ?? '') };
  }
}

/**
 * TCP connect to an external address from the bare host, with a short
 * timeout.  Arms the external canary only when the host itself demonstrably
 * reaches the target: an offline (or filtering) host cannot tell sandbox
 * denial from network absence, so the canary goes inconclusive and the
 * posture stays uncertifiable.
 */
function externalControl(
  host: string,
  port: number,
  timeoutMs = 3_000,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () =>
      finish(false, `no route to ${host}:${port} within ${timeoutMs}ms`),
    );
    socket.on('error', (error) => finish(false, `${host}:${port}: ${error.message}`));
    socket.on('connect', () => finish(true, `bare host connected to ${host}:${port}`));
  });
}

async function loopbackPort(): Promise<
  { port: number; close: () => Promise<void> } | { error: string }
> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    server.on('error', (error) => resolve({ error: error.message }));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

interface ProbeScratch {
  root: string;
  workspace: string;
  sibling: string;
}

async function withScratch<T>(
  adapter: SandboxBackendAdapter,
  run: (scratch: ProbeScratch) => Promise<T>,
): Promise<T> {
  // The escape canaries target three zones: the parent's own temp dir (on
  // darwin a user-data zone outside the seatbelt read allowlist; under bwrap
  // or a container simply never mounted), a SIBLING directory created beside
  // the workspace under the SAME parent — the exact surface the audit's
  // broad-root allow would have leaked — and a symlink from inside the
  // workspace pointing at it.  The workspace lives in the adapter's runnable
  // parent, so the workspace controls stay positive.
  const root = await mkdtemp(join(tmpdir(), 'cq-sbx-root-'));
  const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-ws-'));
  const sibling = await mkdtemp(join(dirname(workspace), 'cq-sbx-sib-'));
  try {
    return await run({ root, workspace, sibling });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
}

/**
 * Probe ONE adapter with the live canaries.  Every canary that asserts a
 * denial has a positive control somewhere — workspace controls inside the
 * launcher, a bare-host twin beside it, or a bare-host reachability check —
 * so a launcher that fails wholesale cannot masquerade as confinement.
 */
export async function probeBackend(
  adapter: SandboxBackendAdapter,
  options: ProbeOptions = {},
): Promise<BackendProbeRecord> {
  const platform = options.platform ?? process.platform;
  const network = options.network ?? 'model-only';
  const timeoutMs = options.timeoutMs ?? 20_000;
  const modelProxy = options.modelProxy === true && network === 'model-only';
  const base = { backend: adapter.backend, platform, network };
  const demonstrated: NetworkDemonstrated =
    network === 'allow' ? 'allow' : modelProxy ? 'proxy-loopback' : 'none';

  const availability = await adapter.available();
  if (!availability.available) {
    return {
      ...base,
      networkDemonstrated: 'none',
      runnable: false,
      certified: false,
      ...(availability.blocker !== undefined ? { blocker: availability.blocker } : {}),
      canaries: [],
    };
  }
  if (modelProxy && adapter.supportsProxyModelOnly !== true) {
    // Uncertifiable posture: refuse the backend rather than certifying a
    // weaker boundary than the posture demands.
    return {
      ...base,
      networkDemonstrated: 'none',
      runnable: false,
      certified: false,
      blocker:
        'backend cannot compose a loopback proxy under model-only; the proxy-composed posture is uncertifiable for this backend',
      canaries: [],
    };
  }

  return withScratch(adapter, async ({ root, workspace, sibling }) => {
    const canaries: CanaryOutcome[] = [];
    const secret = `cq-probe-secret-${randomBytes(8).toString('hex')}`;
    const sentinel = join(root, 'cq-sentinel');
    await writeFile(sentinel, 'escape-target');
    const siblingSentinel = join(sibling, 'cq-sibling-sentinel');
    await writeFile(siblingSentinel, 'sibling-escape-target');
    const symlinkEscape = join(workspace, 'link-to-sentinel');
    const homeCanary = join(homedir(), `.cq-probe-canary-${randomBytes(4).toString('hex')}`);
    await writeFile(homeCanary, 'credential-target');
    const parentEnv: Record<string, string | undefined> = {
      ...process.env,
      CQ_PROBE_CANARY_SECRET: secret,
    };

    let proxyPort: number | undefined;
    const launch = (argv: readonly string[], launchTimeoutMs = timeoutMs) =>
      adapter.launch({
        workspace,
        argv,
        parentEnv,
        network,
        ...(proxyPort !== undefined ? { proxyPort } : {}),
        timeoutMs: launchTimeoutMs,
        maxOutputChars: 4_000,
      });

    try {
      // 1 — control: the launcher must actually execute and grant the workspace.
      const touch = await launch(['/usr/bin/touch', join(workspace, 'cq-canary-out')]);
      const inWs = touch.ok ? await launch(['/bin/cat', join(workspace, 'cq-canary-out')]) : touch;
      canaries.push(
        inWs.ok
          ? {
              id: 'workspace-control',
              verdict: 'pass',
              detail: `workspace exec + rw ok (${detail(touch)})`,
            }
          : { id: 'workspace-control', verdict: 'fail', detail: detail(inWs) },
      );

      // 2 — the child must not read outside the workspace (parent temp tree).
      const escapeRead = await launch(['/bin/cat', sentinel]);
      canaries.push(denialOutcome('read-escape', escapeRead, `read a file in ${root}`));

      // 3 — the child must not read the SIBLING directory beside the workspace:
      // the exact surface a broad-root allow would have leaked.
      const siblingControl = await hostExec(['/bin/cat', siblingSentinel]);
      if (!siblingControl.ok) {
        canaries.push({
          id: 'read-escape-sibling',
          verdict: 'inconclusive',
          detail: `bare host cannot read the sibling sentinel, canary cannot fire: ${siblingControl.stderr}`,
        });
      } else {
        const siblingRead = await launch(['/bin/cat', siblingSentinel]);
        canaries.push(
          denialOutcome('read-escape-sibling', siblingRead, 'read a sibling of the workspace'),
        );
      }

      // 4 — a symlink INSIDE the workspace must not smuggle an outside read:
      // the link targets the sibling sentinel, which exists on the host, so
      // only the boundary can stop the read.
      await symlink(siblingSentinel, symlinkEscape);
      const symlinkRead = await launch(['/bin/cat', symlinkEscape]);
      canaries.push(
        denialOutcome(
          'symlink-escape',
          symlinkRead,
          `read through a workspace symlink to ${siblingSentinel}`,
        ),
      );

      // 5 — the boundary must hold for DESCENDANTS: a nested child (a shell
      // spawning a grandchild) attempting the sibling escape.
      const nestedRead = await launch(['/bin/bash', '-c', `/bin/cat '${siblingSentinel}'`]);
      canaries.push(
        denialOutcome(
          'nested-child-escape',
          nestedRead,
          'a nested child read the sibling sentinel',
        ),
      );

      // 6 — the child must not write outside the workspace.
      const escapePath = join(root, 'cq-escape');
      const escapeWrite = await launch(['/usr/bin/touch', escapePath]);
      canaries.push(denialOutcome('write-escape', escapeWrite, `created ${escapePath}`));

      // 7 — a parent secret must not reach the child env.  The bare-host
      // control proves the secret really is in the parent, so the scrub
      // cannot be vacuous; `printenv NAME` keeps the child answer tiny, so a
      // truncated full-env dump cannot hide a leak behind the output cap.
      const presenceEnv: Record<string, string> = {};
      for (const [name, value] of Object.entries(parentEnv)) {
        if (value !== undefined) presenceEnv[name] = value;
      }
      const presence = await hostExec(['/usr/bin/printenv', 'CQ_PROBE_CANARY_SECRET'], presenceEnv);
      const envRead = await launch(['/usr/bin/printenv', 'CQ_PROBE_CANARY_SECRET']);
      canaries.push(
        !presence.ok
          ? {
              id: 'credential-env',
              verdict: 'inconclusive',
              detail: `bare-host printenv failed, canary cannot fire: ${presence.stderr}`,
            }
          : envRead.ok
            ? {
                id: 'credential-env',
                verdict: 'fail',
                detail: envRead.stdout.includes(secret)
                  ? 'CQ_PROBE_CANARY_SECRET reached the child'
                  : 'printenv found the name with a different value',
              }
            : !executed(envRead)
              ? {
                  id: 'credential-env',
                  verdict: 'inconclusive',
                  detail: `printenv never ran: ${detail(envRead)}`,
                }
              : envRead.exitCode !== 1
                ? {
                    id: 'credential-env',
                    verdict: 'inconclusive',
                    detail: `printenv failed: ${detail(envRead)}`,
                  }
                : { id: 'credential-env', verdict: 'pass', detail: detail(envRead) },
      );

      // 8 — the child must not read a credential beside the user's home files.
      const credRead = await launch(['/bin/cat', homeCanary]);
      canaries.push(denialOutcome('credential-file', credRead, `read ${homeCanary}`));

      // 9-11 — network, posture-aware.  The bare-host controls arm each
      // canary; a control that cannot fire leaves the canary inconclusive and
      // the posture uncertifiable.
      const external = { host: '8.8.8.8', port: 53 };
      const externalArm = await externalControl(external.host, external.port);
      if (modelProxy) {
        const proxy = await loopbackPort();
        const other = await loopbackPort();
        if (!('port' in proxy) || !('port' in other)) {
          const why = !('port' in proxy)
            ? proxy.error
            : !('port' in other)
              ? other.error
              : 'unknown listener failure';
          canaries.push({
            id: 'network-proxy',
            verdict: 'inconclusive',
            detail: `listener failed: ${why}`,
          });
        } else {
          proxyPort = proxy.port;
          try {
            const connectTo = (host: string, port: number) => [
              '/bin/bash',
              '--norc',
              '-c',
              `exec 3<>/dev/tcp/${host}/${port}`,
            ];
            const proxyArm = await hostExec(connectTo('127.0.0.1', proxy.port));
            const otherArm = await hostExec(connectTo('127.0.0.1', other.port));
            const proxyConnect = await launch(connectTo('127.0.0.1', proxy.port));
            const otherConnect = await launch(connectTo('127.0.0.1', other.port));
            const externalConnect = await launch(connectTo(external.host, external.port));
            if (!proxyArm.ok || !otherArm.ok || !externalArm.ok) {
              canaries.push({
                id: 'network-proxy',
                verdict: 'inconclusive',
                detail: `bare-host control failed, canary cannot fire: ${!proxyArm.ok ? proxyArm.stderr : !otherArm.ok ? otherArm.stderr : externalArm.detail}`,
              });
            } else if (
              !executed(proxyConnect) ||
              !executed(otherConnect) ||
              !executed(externalConnect)
            ) {
              canaries.push({
                id: 'network-proxy',
                verdict: 'inconclusive',
                detail: `bash never ran inside the boundary: ${!executed(proxyConnect) ? detail(proxyConnect) : !executed(otherConnect) ? detail(otherConnect) : detail(externalConnect)}`,
              });
            } else if (proxyConnect.ok && !otherConnect.ok && !externalConnect.ok) {
              canaries.push({
                id: 'network-proxy',
                verdict: 'pass',
                detail: `proxy port ${proxy.port} connected; other loopback (${other.port}) and external egress refused`,
              });
            } else {
              canaries.push({
                id: 'network-proxy',
                verdict: 'fail',
                detail: proxyConnect.ok
                  ? otherConnect.ok
                    ? `child connected to non-proxy port ${other.port}`
                    : externalConnect.ok
                      ? `child reached external ${external.host}:${external.port}`
                      : 'proxy connect itself failed'
                  : 'child could not reach the permitted proxy port',
              });
            }
          } finally {
            await proxy.close();
            await other.close();
            proxyPort = undefined;
          }
        }
      } else {
        const listener = await loopbackPort();
        if (!('port' in listener)) {
          canaries.push({
            id: 'network-loopback',
            verdict: 'inconclusive',
            detail: `listener failed: ${listener.error}`,
          });
        } else {
          try {
            const port = listener.port;
            const connectArgv = ['--norc', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`];
            const control = await hostExec(['/bin/bash', ...connectArgv]);
            const sandboxed = await launch(['/bin/bash', ...connectArgv]);
            if (!control.ok) {
              canaries.push({
                id: 'network-loopback',
                verdict: 'inconclusive',
                detail: `bare-host connect failed, canary cannot fire: ${control.stderr}`,
              });
            } else if (!executed(sandboxed)) {
              canaries.push({
                id: 'network-loopback',
                verdict: 'inconclusive',
                detail: `bash never ran inside the boundary: ${detail(sandboxed)}`,
              });
            } else if (sandboxed.ok !== (network === 'allow')) {
              canaries.push({
                id: 'network-loopback',
                verdict: 'fail',
                detail:
                  network === 'allow'
                    ? `child could not connect to 127.0.0.1:${port} under allow posture`
                    : `child connected to 127.0.0.1:${port}`,
              });
            } else {
              // Surface the connect-denial line, not incidental startup noise.
              const denial =
                sandboxed.stderr
                  .split('\n')
                  .find((line) => /connect|dev\/tcp|network/i.test(line)) ??
                firstLine(sandboxed.stderr);
              canaries.push({ id: 'network-loopback', verdict: 'pass', detail: denial });
            }
          } finally {
            await listener.close();
          }
        }
        if (!externalArm.ok) {
          canaries.push({
            id: 'network-external',
            verdict: 'inconclusive',
            detail: `bare host cannot reach ${external.host}:${external.port}; offline hosts cannot certify egress denial (${externalArm.detail})`,
          });
        } else {
          const externalConnect = await launch([
            '/bin/bash',
            '--norc',
            '-c',
            `exec 3<>/dev/tcp/${external.host}/${external.port}`,
          ]);
          canaries.push(
            externalConnect.ok
              ? {
                  id: 'network-external',
                  verdict: 'fail',
                  detail: `child reached external ${external.host}:${external.port}`,
                }
              : !executed(externalConnect)
                ? {
                    id: 'network-external',
                    verdict: 'inconclusive',
                    detail: `bash never ran inside the boundary: ${detail(externalConnect)}`,
                  }
                : { id: 'network-external', verdict: 'pass', detail: detail(externalConnect) },
          );
        }
      }
    } finally {
      await rm(homeCanary, { force: true });
    }

    const controlOk = canaries.find((c) => c.id === 'workspace-control')?.verdict === 'pass';
    const runnable = controlOk;
    const denied = canaries
      .filter((c) => c.id !== 'workspace-control')
      .every((c) => c.verdict === 'pass');
    const blocker = !controlOk
      ? `launcher did not run a child in the workspace: ${canaries.find((c) => c.id === 'workspace-control')?.detail ?? 'no control canary'}`
      : denied
        ? undefined
        : canaries
            .filter((c) => c.verdict !== 'pass')
            .map((c) => `${c.id} ${c.verdict}: ${c.detail}`)
            .join('; ');
    return {
      ...base,
      networkDemonstrated: controlOk && denied ? demonstrated : 'none',
      runnable,
      certified: controlOk && denied,
      ...(blocker !== undefined ? { blocker } : {}),
      canaries,
    };
  });
}

/**
 * Probe the platform's candidate list and certify only what the canaries
 * earned.  This is the B14 entry the suite variant calls before required mode
 * may execute anywhere: absent certified backends it returns an empty list,
 * which keeps `CQ_SANDBOX=required` fail-closed.  The returned object carries
 * a probe-internal receipt; `launchCertified` refuses anything else.
 */
export async function certifyBackends(options: ProbeOptions = {}): Promise<SandboxCertification> {
  const platform = options.platform ?? process.platform;
  const network = options.network ?? 'model-only';
  const modelProxy = options.modelProxy === true && network === 'model-only';
  const adapters = options.adapters ?? adaptersForPlatform(platform);
  const records: BackendProbeRecord[] = [];
  for (const adapter of adapters) {
    records.push(await probeBackend(adapter, { ...options, platform, network }));
  }
  const certification: SandboxCertification = {
    platform,
    probedAt: new Date().toISOString(),
    network,
    networkDemonstrated: network === 'allow' ? 'allow' : modelProxy ? 'proxy-loopback' : 'none',
    records,
    certified: records.filter((r) => r.certified).map((r) => r.backend),
  };
  probeEarned.add(certification);
  return certification;
}

/** The only certified list a caller may hand to `resolveSandboxConfig`. */
export function certifiedBackendsOf(
  certification: SandboxCertification,
): readonly SandboxBackend[] {
  return certification.certified;
}

/**
 * Required-mode execution primitive: run a command INSIDE a probe-certified
 * backend, or fail closed.  Three gates, each naming its own failure: the
 * certification must have been PRODUCED by this probe (a caller-forged
 * object is refused outright); the backend must be certified for required
 * mode; and the requested posture must match what the probe demonstrated —
 * a model-only certification does not authorize an allow launch, and a
 * proxy-composed certification is only valid for launches that carry the
 * proxy port.  Absent all three, the error carries the exact blocker plus
 * the resolver's config hint, so a missing backend can never degrade into a
 * host shell.
 */
export async function launchCertified(
  adapter: SandboxBackendAdapter,
  certification: SandboxCertification,
  request: {
    workspace: string;
    argv: readonly string[];
    parentEnv?: Readonly<Record<string, string | undefined>>;
    envPassthrough?: readonly string[];
    network: SandboxNetwork;
    proxyPort?: number;
    timeoutMs?: number;
    maxOutputChars?: number;
  },
): Promise<SandboxLaunchResult> {
  assertProbeEarned(certification);
  if (!certification.certified.includes(adapter.backend)) {
    const record = certification.records.find((r) => r.backend === adapter.backend);
    const blocker = record?.blocker ?? 'backend was not probed by this certification';
    throw new Error(
      `sandbox: ${adapter.backend} is not certified for required mode (${blocker}); ` +
        'CQ_SANDBOX=required is fail-closed until a certified backend launcher is configured',
    );
  }
  if (request.network !== certification.network) {
    throw new Error(
      `sandbox: ${adapter.backend} was certified under the '${certification.network}' posture, ` +
        `not the requested '${request.network}'; certification does not transfer across postures ` +
        'and CQ_SANDBOX=required is fail-closed',
    );
  }
  const proxyDemonstrated = certification.networkDemonstrated === 'proxy-loopback';
  if ((request.proxyPort !== undefined) !== proxyDemonstrated) {
    throw new Error(
      `sandbox: ${adapter.backend} was certified with '${certification.networkDemonstrated}' egress; ` +
        (proxyDemonstrated
          ? 'a proxyPort is required on every launch'
          : 'proxyPort is not permitted on a launch certified without a proxy') +
        ' — the launch profile must be the profile the canaries proved; CQ_SANDBOX=required is fail-closed',
    );
  }
  return adapter.launch(request);
}
