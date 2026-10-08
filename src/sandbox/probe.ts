// The RS-13 live boundary probe (B14): a backend is certified ONLY when real
// canaries executed inside its launcher demonstrate the boundary, and every
// positive control proves the canary ran for real.  There is no synthetic
// pass: a launcher that blocks everything fails its controls and stays
// uncertified; a backend that cannot run at all records the exact
// environmental blocker and stays uncertified; an inconclusive canary
// (control failed, canary binary never executed) also refuses certification —
// doubt fails closed.
//
// Canary coverage (Sol audit, probe.ts:208; delta review P2): escape attempts
// probe the parent temp tree, a SIBLING directory beside the workspace
// (inside the broad-root allow surface the audit rejected — this canary is
// what bites that gap), a SYMLINK from inside the workspace to that sibling,
// and a NESTED child (a shell spawning a grandchild) so the boundary is
// proven for descendants, not just the direct child.  Every FILE denial is
// attributed by a positive control proving the target exists and is readable
// (or the directory writable) on the bare host, and the nested/external legs
// are armed by an IN-BOUNDARY control proving the shell-execution path itself
// works inside the boundary — a nonzero exit alone is never evidence (delta
// review P2).  Network coverage is posture-aware: loopback to a live
// listener, an EXTERNAL connect to a public resolver (armed only when the
// bare host demonstrably reaches it — an offline host cannot certify egress
// denial and fails closed), and for the proxy-composed model-only posture,
// egress through the ONE permitted local proxy port plus denial of every
// other port.  A LOCAL-PREFIX canary attacks the accepted P7 deviation
// surface: executing a host-present /usr/local/bin binary must be refused.
//
// `certifyBackends` results carry a probe-internal receipt (a module-private
// WeakMap): an immutable snapshot binding the certification to the EXACT
// adapter instances that passed and to the demonstrated posture.  Every
// `launchCertified` gate reads that receipt, never the caller-visible fields,
// so caller mutation or a caller-forged list cannot widen what a launch may
// do, and a different adapter instance sharing the backend name inherits
// nothing (Sol audit probe.ts:417; delta review P1).
//
// The certified list this module emits is the ONLY intended source for
// `resolveSandboxConfig({ certifiedBackends })`; `certifiedBackendsOf` types
// that handoff so no caller can name a backend the probe never ran.
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  | 'proc-link-escape'
  | 'symlink-escape'
  | 'nested-child-escape'
  | 'write-escape'
  | 'local-prefix-exec'
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
   * This stand-in provides diagnostic observations only: it cannot certify
   * the identity/lifetime or upstream allowlist of a production proxy.
   */
  modelProxy?: boolean;
  timeoutMs?: number;
  /**
   * Test seam: the "external" egress target the bare-host control and the
   * in-boundary connect both use.  Defaults to 8.8.8.8:53; a deterministic
   * test points it at a loopback listener so verdicts do not depend on the
   * host's outbound connectivity.
   */
  externalTarget?: { host: string; port: number };
  /**
   * Test seam: the host-present executable the local-prefix canary attacks.
   * Defaults to the first entry under /usr/local/bin (or /usr/local/share).
   */
  localPrefixTarget?: string;
}

/**
 * The probe receipt (Sol delta review, P1): the authoritative record of what
 * a certification actually earned, keyed by the certification OBJECT and
 * binding the EXACT adapter instances that were probed.  Every launch gate
 * reads THIS snapshot, never the caller-visible fields, so mutating a
 * certification object (or forging one) cannot widen what `launchCertified`
 * enforces, and a different adapter instance that merely shares the backend
 * name does not inherit the certification.
 */
interface ProbeReceipt {
  platform: NodeJS.Platform;
  network: SandboxNetwork;
  networkDemonstrated: NetworkDemonstrated;
  /** Every probed adapter object → its blocker ('' when it certified). */
  probedAdapters: ReadonlyMap<
    SandboxBackendAdapter,
    { blocker: string; launch: SandboxBackendAdapter['launch'] }
  >;
  /** Frozen certified-backend list `certifiedBackendsOf` hands out. */
  certified: readonly SandboxBackend[];
}

const probeReceipts = new WeakMap<SandboxCertification, ProbeReceipt>();

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
 * timeout, a 126/127 exit (could not exec / not found), or a SIGNAL death
 * (exitCode null — e.g. the darwin deny-default SIGABRT before main) means
 * the canary's command never provably executed, so a nonzero exit is NOT
 * evidence of a boundary — it is an inconclusive answer.  A genuine denial
 * exits 1 with an "Operation not permitted"-class error.
 */
function executed(r: { spawnError?: string; timedOut: boolean; exitCode: number | null }): boolean {
  return (
    r.spawnError === undefined &&
    !r.timedOut &&
    r.exitCode !== null &&
    r.exitCode !== 126 &&
    r.exitCode !== 127
  );
}

/**
 * A read/write denial verdict for one target (delta review P2): the exit is
 * attributed to the boundary only when the canary binary actually ran AND the
 * positive control proved the same operation succeeds on the bare host (the
 * target exists and is readable, or the directory writable).  An unarmed or
 * unexecuted canary is inconclusive — a nonzero exit alone is not evidence.
 */
function denialOutcome(
  id: CanaryId,
  result: SandboxLaunchResult,
  armed: boolean,
  what: string,
): CanaryOutcome {
  if (result.ok) return { id, verdict: 'fail', detail: what };
  if (!armed)
    return { id, verdict: 'inconclusive', detail: `control did not arm: ${detail(result)}` };
  if (!executed(result))
    return { id, verdict: 'inconclusive', detail: `canary never ran: ${detail(result)}` };
  return { id, verdict: 'pass', detail: detail(result) };
}

/**
 * Whether a non-ok launch of an OUTSIDE-ALLOWLIST binary is attributable to
 * the boundary refusing the exec — not to an unrelated launcher failure or
 * (exit-1-class) tool behavior.  The binary never ran, so its stdout must be
 * empty, and the failure itself must name exec/permission machinery
 * (sandbox-exec's "execvp ... Operation not permitted", bwrap's
 * "Can't execute", the container CLI's OCI exec refusal, or an ENOENT from a
 * namespace that hides the target).  Anything else is unattributable.
 */
function execRefusalAttributable(
  backend: SandboxBackend,
  target: string,
  r: SandboxLaunchResult,
): boolean {
  // Provenance must come from the LAUNCHER'S OWN EXEC-MACHINERY REPORT, not
  // from any permission-flavored text (delta review round 3): a binary that
  // executed and then failed internally can print "<target>: cannot execute
  // ...: Permission denied", so substring-plus-signature is forgeable by
  // coincidence.  Each anchor is the launcher's structured error line —
  // line-anchored launcher prefix, the execverb, and the EXACT target — or
  // the canonical execvp failure form.  Anything else is inconclusive; a
  // genuine denial the launcher reports in another shape withholds
  // certification rather than earning it.
  if (r.stdout.trim() !== '') return false;
  const evidence = `${r.spawnError ?? ''}\n${r.stderr}`;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Residual limit, stated honestly: stderr is a shared channel, so a binary
  // that executed could PARODY its launcher's line shape.  The anchors raise
  // the bar to launcher-shaped, target-exact, exec-specific lines; perfect
  // provenance would need an out-of-band launcher protocol (a redesign, not
  // this lane).  A genuine denial reported in another shape is inconclusive.
  const anchored: Record<string, RegExp> = {
    seatbelt: new RegExp(`^sandbox-exec: execvp\\(\\) of '${escaped}' failed:`, 'm'),
    bwrap: new RegExp(
      `^bwrap:\\s*(?:execvp|can't execute|cannot execute|exec)\\b[^\\n]*${escaped}`,
      'im',
    ),
    // The OCI runtime's start failure as the CLI relays it: one line naming
    // the OCI runtime and the exact target in runc's exec: "<target>" form
    // or crun's executable-file form (crq delta review: the earlier pattern
    // required an impossible word boundary right after a colon).
    container: new RegExp(
      `^(?=[^\\n]*oci runtime)(?:docker: |error(?: response from daemon)?: )[^\\n]*(?:exec: "${escaped}"|executable file \`${escaped}\`)`,
      'im',
    ),
    landlock: new RegExp(`^landlock.*exec[^\\n]*${escaped}`, 'im'),
  };
  const canonical = new RegExp(`execvp\\(\\) of '${escaped}' failed:`, 'm');
  const pattern = anchored[backend];
  return (pattern !== undefined && pattern.test(evidence)) || canonical.test(evidence);
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
 * Whether a binary RAN on the bare host at all — ok or nonzero, but not
 * missing/unreadable.  Arms the local-prefix canary: the control only needs
 * to prove the target is executable OUTSIDE the boundary.
 */
async function hostRan(
  file: string,
  args: readonly string[],
): Promise<{ ran: boolean; ok: boolean; stderr: string }> {
  try {
    await execFile(file, args, { timeout: 10_000 });
    return { ran: true, ok: true, stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: string;
      stderr?: string;
      message?: string;
    };
    const ran = err.code !== 'ENOENT' && err.code !== 'EACCES';
    return { ran, ok: false, stderr: firstLine(err.stderr ?? err.message ?? '') };
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

/**
 * First EXECUTABLE regular file under /usr/local/bin, else /usr/local/share —
 * the local-prefix attack surface for the P7 deviation probe.  readdir order
 * is no eligibility guarantee, so directories and non-executables are skipped.
 * undefined when the host carries no such content.
 */
async function firstLocalPrefixTarget(): Promise<string | undefined> {
  for (const dir of ['/usr/local/bin', '/usr/local/share']) {
    try {
      const entries = await readdir(dir);
      for (const name of entries.sort()) {
        if (name.startsWith('.')) continue;
        const candidate = join(dir, name);
        try {
          if (!(await stat(candidate)).isFile()) continue;
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Unusable entry (dangling link, no exec bit) — keep scanning.
        }
      }
    } catch {
      // Prefix absent on this host — the caller records the n/a verdict.
    }
  }
  return undefined;
}

interface ProbeScratch {
  root: string;
  workspace: string;
  sibling: string;
}

async function removeScratch(paths: readonly string[]): Promise<void> {
  const cleanups = await Promise.allSettled(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  const failed = cleanups.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((r): unknown => r.reason),
      'sandbox scratch cleanup failed',
    );
  }
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
  const allocated: string[] = [];
  try {
    const root = await mkdtemp(join(tmpdir(), 'cq-sbx-root-'));
    allocated.push(root);
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-ws-'));
    allocated.push(workspace);
    // mkdtemp is owner-only; a non-root container UID (65532) could not
    // traverse or write the bind mount, so the workspace control would fail
    // for a usable container.  The scratch dir is empty and ephemeral.
    await chmod(workspace, 0o777);
    const sibling = await mkdtemp(join(dirname(workspace), 'cq-sbx-sib-'));
    allocated.push(sibling);
    return await run({ root, workspace, sibling });
  } finally {
    // Setup itself can fail partway through. Attempt every removal even if
    // another cleanup fails, and surface cleanup failures to the caller.
    await removeScratch(allocated);
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
  return (await probeBackendWithLaunch(adapter, options)).record;
}

/**
 * Internal probe that also returns the EXACT `launch` function it exercised —
 * the receipt binds that reference, so replacing `adapter.launch` after
 * certification is detected instead of inherited (delta review 3).
 */
async function probeBackendWithLaunch(
  adapter: SandboxBackendAdapter,
  options: ProbeOptions,
): Promise<{ record: BackendProbeRecord; launchRef: SandboxBackendAdapter['launch'] }> {
  // Bind the launch function at entry: every canary below goes through THIS
  // reference, and the receipt hands back precisely what was exercised.
  const launchRef = adapter.launch;
  const launchVia = (request: Parameters<SandboxBackendAdapter['launch']>[0]) =>
    launchRef.call(adapter, request);
  const platform = options.platform ?? process.platform;
  const network = options.network ?? 'model-only';
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (options.modelProxy === true && network === 'allow') {
    throw new Error(
      "modelProxy requires network 'model-only'; it contradicts network 'allow' (unrestricted egress)",
    );
  }
  const modelProxy = options.modelProxy === true;
  const base = { backend: adapter.backend, platform, network };
  const demonstrated: NetworkDemonstrated =
    network === 'allow' ? 'allow' : modelProxy ? 'proxy-loopback' : 'none';

  const availability = await adapter.available();
  if (!availability.available) {
    return {
      record: {
        ...base,
        networkDemonstrated: 'none',
        runnable: false,
        certified: false,
        ...(availability.blocker !== undefined ? { blocker: availability.blocker } : {}),
        canaries: [],
      },
      launchRef,
    };
  }
  if (modelProxy && adapter.supportsProxyModelOnly !== true) {
    // Uncertifiable posture: refuse the backend rather than certifying a
    // weaker boundary than the posture demands.
    return {
      record: {
        ...base,
        networkDemonstrated: 'none',
        runnable: false,
        certified: false,
        blocker:
          'backend cannot compose a loopback proxy under model-only; the proxy-composed posture is uncertifiable for this backend',
        canaries: [],
      },
      launchRef,
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
    const parentEnv: Record<string, string | undefined> = {
      ...process.env,
      CQ_PROBE_CANARY_SECRET: secret,
    };

    let proxyPort: number | undefined;
    const launch = (argv: readonly string[], launchTimeoutMs = timeoutMs) =>
      launchVia({
        workspace,
        argv,
        parentEnv,
        network,
        ...(proxyPort !== undefined ? { proxyPort } : {}),
        timeoutMs: launchTimeoutMs,
        maxOutputChars: 4_000,
      });

    let homeCanaryCreated = false;
    try {
      const homeFile = await open(homeCanary, 'wx', 0o600);
      homeCanaryCreated = true;
      try {
        await homeFile.writeFile('credential-target');
      } finally {
        await homeFile.close();
      }
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

      // In-boundary shell control (delta review P2): a grandchild spawned via
      // `bash -c` must EXECUTE inside the boundary before any bash -c canary
      // (nested-child, external, proxy connects) can attribute a nonzero exit
      // to the boundary rather than to a broken execution path.  `/usr/bin/true`
      // (not /bin/true — absent on some macOS installs) and `--norc`: bash's
      // rshd heuristic sources ~/.bashrc on a socket stdin, and the boundary
      // rightly denies that read — the control must not fail on its own noise.
      const shellControl = await launch(['/bin/bash', '--norc', '-c', '/usr/bin/true']);
      const shellArmed = shellControl.ok;

      // Bare-host read/write controls (delta review P2): each file-denial
      // canary is attributed only when the SAME operation demonstrably
      // succeeds outside the boundary.
      const readControl = await hostExec(['/bin/cat', sentinel]);
      const writeControl = await hostExec(['/usr/bin/touch', join(root, 'cq-write-control')]);
      const credControl = await hostExec(['/bin/cat', homeCanary]);

      // 2 — the child must not read outside the workspace (parent temp tree).
      const escapeRead = await launch(['/bin/cat', sentinel]);
      canaries.push(
        denialOutcome('read-escape', escapeRead, readControl.ok, `read a file in ${root}`),
      );

      // Linux procfs magic links can expose a host process's root even
      // when its filesystem is not mounted. Arm the exact link on the host;
      // a private PID namespace must make that host PID unreachable.
      if (process.platform === 'linux') {
        const procTarget = `/proc/${process.pid}/root${sentinel}`;
        const procControl = await hostExec(['/bin/cat', procTarget]);
        const procRead = await launch(['/bin/cat', procTarget]);
        canaries.push(
          denialOutcome(
            'proc-link-escape',
            procRead,
            procControl.ok,
            'read host root through procfs',
          ),
        );
      }

      // 3 — the child must not read the SIBLING directory beside the workspace:
      // the exact surface a broad-root allow would have leaked.
      const siblingControl = await hostExec(['/bin/cat', siblingSentinel]);
      const siblingRead = await launch(['/bin/cat', siblingSentinel]);
      canaries.push(
        denialOutcome(
          'read-escape-sibling',
          siblingRead,
          siblingControl.ok,
          'read a sibling of the workspace',
        ),
      );

      // 4 — a symlink INSIDE the workspace must not smuggle an outside read:
      // the link targets the sibling sentinel, which the bare host reads
      // THROUGH THE LINK (control) — only the boundary can stop the child.
      await symlink(siblingSentinel, symlinkEscape);
      const symlinkControl = await hostExec(['/bin/cat', symlinkEscape]);
      const symlinkRead = await launch(['/bin/cat', symlinkEscape]);
      canaries.push(
        denialOutcome(
          'symlink-escape',
          symlinkRead,
          symlinkControl.ok,
          `read through a workspace symlink to ${siblingSentinel}`,
        ),
      );

      // 5 — the boundary must hold for DESCENDANTS: a nested child (a shell
      // spawning a grandchild) attempting the sibling escape.  Armed by the
      // in-boundary shell control, so a nonzero exit is attributable.
      // The path rides as a positional argument: interpolating it into shell
      // source would let a quote in the temp path yield a syntax error that
      // exits nonzero and reads as a denial.
      const nestedRead = await launch([
        '/bin/bash',
        '-c',
        '/bin/cat "$1"',
        'cq-nested',
        siblingSentinel,
      ]);
      canaries.push(
        denialOutcome(
          'nested-child-escape',
          nestedRead,
          shellArmed,
          'a nested child read the sibling sentinel',
        ),
      );

      // 6 — the child must not write outside the workspace.
      const escapePath = join(root, 'cq-escape');
      const escapeWrite = await launch(['/usr/bin/touch', escapePath]);
      canaries.push(
        denialOutcome('write-escape', escapeWrite, writeControl.ok, `created ${escapePath}`),
      );

      // 6b — LOCAL-PREFIX attack control (delta review): the accepted P7
      // trial denies exec outside /usr/bin,/bin,/sbin,/usr/libexec — prove a
      // host-present /usr/local/bin binary cannot EXEC inside the boundary.
      // Every verdict here is earned: a host with no local-prefix content
      // cannot demonstrate the denial and stays inconclusive (a synthetic
      // pass would certify an unproven boundary), and a launch that timed
      // out, failed to spawn, or crashed is never read as a refusal.
      const localBin = options.localPrefixTarget ?? (await firstLocalPrefixTarget());
      if (localBin === undefined) {
        canaries.push({
          id: 'local-prefix-exec',
          verdict: 'inconclusive',
          detail:
            'no /usr/local content on this host to attack; the exec allowlist omits /usr/local (construction-tested) but the denial itself was not demonstrable',
        });
      } else {
        const arm = await hostRan(localBin, ['--version']);
        const sandboxed = await launch([localBin, '--version']);
        canaries.push(
          !arm.ran
            ? {
                id: 'local-prefix-exec',
                verdict: 'inconclusive',
                detail: `bare host cannot run ${localBin}, canary cannot fire: ${arm.stderr}`,
              }
            : sandboxed.ok
              ? { id: 'local-prefix-exec', verdict: 'fail', detail: `executed ${localBin}` }
              : !executed(sandboxed) &&
                  !(
                    // An OCI runtime reports a hidden/denied exec as 126/127;
                    // that is a refusal only when the launcher's own
                    // exec-machinery line names this exact target.
                    sandboxed.spawnError === undefined &&
                    !sandboxed.timedOut &&
                    (sandboxed.exitCode === 126 || sandboxed.exitCode === 127) &&
                    execRefusalAttributable(adapter.backend, localBin, sandboxed)
                  )
                ? {
                    id: 'local-prefix-exec',
                    verdict: 'inconclusive',
                    detail: `canary never ran: ${detail(sandboxed)}`,
                  }
                : execRefusalAttributable(adapter.backend, localBin, sandboxed)
                  ? {
                      id: 'local-prefix-exec',
                      verdict: 'pass',
                      detail: `exec of ${localBin} refused: ${detail(sandboxed)}`,
                    }
                  : {
                      id: 'local-prefix-exec',
                      verdict: 'inconclusive',
                      detail: `refusal not attributable to an exec denial: ${detail(sandboxed)}`,
                    },
        );
      }

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
      canaries.push(
        denialOutcome('credential-file', credRead, credControl.ok, `read ${homeCanary}`),
      );

      // 9-11 — network, posture-aware.  The bare-host controls arm each
      // canary; a control that cannot fire leaves the canary inconclusive and
      // the posture uncertifiable.
      const external = options.externalTarget ?? { host: '8.8.8.8', port: 53 };
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
          // Either listener may have succeeded before the other failed.
          if ('port' in proxy) await proxy.close();
          if ('port' in other) await other.close();
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
            } else if (!shellArmed) {
              canaries.push({
                id: 'network-proxy',
                verdict: 'inconclusive',
                detail: `in-boundary shell control failed, connect attempts are not attributable: ${detail(shellControl)}`,
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
            } else if (!shellArmed) {
              // Non-vacuity (Sol review): without the in-boundary shell
              // control, a refusal could mean the child never truly ran.
              canaries.push({
                id: 'network-loopback',
                verdict: 'inconclusive',
                detail: `in-boundary shell control failed, connect refusal is not attributable: ${detail(shellControl)}`,
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
              canaries.push({
                id: 'network-loopback',
                verdict: 'pass',
                detail:
                  denial.trim() !== ''
                    ? denial
                    : `child connected to 127.0.0.1:${port} under allow posture`,
              });
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
        } else if (!shellArmed) {
          canaries.push({
            id: 'network-external',
            verdict: 'inconclusive',
            detail: `in-boundary shell control failed, connect attempts are not attributable: ${detail(shellControl)}`,
          });
        } else {
          const externalConnect = await launch([
            '/bin/bash',
            '--norc',
            '-c',
            `exec 3<>/dev/tcp/${external.host}/${external.port}`,
          ]);
          // Posture-aware (final-head review): the SAME connect demonstrates
          // egress under `allow` (refusal is the violation) and confinement
          // under `model-only` (reachability is the violation).
          canaries.push(
            externalConnect.ok !== (network === 'allow')
              ? {
                  id: 'network-external',
                  verdict: 'fail',
                  detail:
                    network === 'allow'
                      ? `child could not reach external ${external.host}:${external.port} under allow posture`
                      : `child reached external ${external.host}:${external.port}`,
                }
              : !executed(externalConnect)
                ? {
                    id: 'network-external',
                    verdict: 'inconclusive',
                    detail: `bash never ran inside the boundary: ${detail(externalConnect)}`,
                  }
                : {
                    id: 'network-external',
                    verdict: 'pass',
                    detail:
                      network === 'allow'
                        ? `child reached external ${external.host}:${external.port} under allow posture`
                        : detail(externalConnect),
                  },
          );
        }
      }
    } finally {
      if (homeCanaryCreated) await rm(homeCanary, { force: true });
    }

    const controlOk = canaries.find((c) => c.id === 'workspace-control')?.verdict === 'pass';
    const runnable = controlOk;
    const denied = canaries
      .filter((c) => c.id !== 'workspace-control')
      .every((c) => c.verdict === 'pass');
    const blocker = !controlOk
      ? `launcher did not run a child in the workspace: ${canaries.find((c) => c.id === 'workspace-control')?.detail ?? 'no control canary'}`
      : modelProxy
        ? 'proxy stand-in does not bind a production endpoint identity or upstream allowlist; proxy certification is withheld'
        : denied
          ? undefined
          : canaries
              .filter((c) => c.verdict !== 'pass')
              .map((c) => `${c.id} ${c.verdict}: ${c.detail}`)
              .join('; ');
    return {
      record: {
        ...base,
        networkDemonstrated: controlOk && denied ? demonstrated : 'none',
        runnable,
        certified: controlOk && denied && !modelProxy,
        ...(blocker !== undefined ? { blocker } : {}),
        canaries,
      },
      launchRef,
    };
  });
}

/** Receipt placeholder for a candidate whose probe threw: launches nothing. */
const refuseUnprobedLaunch: SandboxBackendAdapter['launch'] = () =>
  Promise.reject(new Error('sandbox: this launcher probe failed; nothing was certified'));

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
  const adapters = options.adapters ?? adaptersForPlatform(platform);
  const records: BackendProbeRecord[] = [];
  const probedAdapters = new Map<
    SandboxBackendAdapter,
    { blocker: string; launch: SandboxBackendAdapter['launch'] }
  >();
  for (const adapter of adapters) {
    // Bind the reference the canaries EXERCISED, as returned by the probe —
    // a second read of `adapter.launch` here could see a different function
    // from an accessor (Opus review).  The fallback is a refusing sentinel,
    // never a read of `adapter.launch` outside the guard (Codex P2): a
    // throwing accessor must become this candidate's blocker record, not
    // reject the whole certification before later candidates are probed.
    let launchRef: SandboxBackendAdapter['launch'] = refuseUnprobedLaunch;
    let record: BackendProbeRecord;
    try {
      ({ record, launchRef } = await probeBackendWithLaunch(adapter, {
        ...options,
        platform,
        network,
      }));
    } catch (error) {
      // One candidate's probe failure must not hide the others: record it
      // as an uncertified blocker and keep probing the platform order.
      record = {
        backend: adapter.backend,
        platform,
        network,
        networkDemonstrated: 'none',
        runnable: false,
        certified: false,
        blocker: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
        canaries: [],
      };
    }
    records.push(record);
    probedAdapters.set(adapter, {
      blocker: record.certified ? '' : (record.blocker ?? 'probe did not certify this launcher'),
      launch: launchRef,
    });
  }
  // Derive the aggregate egress claim from records that actually
  // demonstrated the posture; no successful observation means 'none'.
  const aggregateDemonstrated: NetworkDemonstrated =
    records.find((r) => r.networkDemonstrated !== 'none')?.networkDemonstrated ?? 'none';
  const certification: SandboxCertification = {
    platform,
    probedAt: new Date().toISOString(),
    network,
    networkDemonstrated: aggregateDemonstrated,
    records,
    certified: Object.freeze(records.filter((r) => r.certified).map((r) => r.backend)),
  };
  // The receipt is the authoritative record (Sol delta review, P1): it binds
  // this certification object to the EXACT adapter instances that were probed
  // and to the demonstrated posture.  The caller-visible fields are
  // informational copies; the launch gates below read only the receipt.
  probeReceipts.set(certification, {
    platform,
    network,
    networkDemonstrated: certification.networkDemonstrated,
    probedAdapters,
    certified: certification.certified,
  });
  return certification;
}

/**
 * The only certified list a caller may hand to `resolveSandboxConfig`.  It
 * comes from the probe receipt, not from the (mutable) public fields, so a
 * mutated or forged certification yields the empty list — fail closed.
 */
export function certifiedBackendsOf(
  certification: SandboxCertification,
): readonly SandboxBackend[] {
  return probeReceipts.get(certification)?.certified ?? [];
}

/**
 * Required-mode execution primitive: run a command INSIDE a probe-certified
 * backend, or fail closed.  The gates read the probe RECEIPT, never the
 * caller-visible fields, and bind to the EXACT adapter instance that was
 * certified (Sol delta review, P1):
 *   - the certification must have been PRODUCED by this probe — a forged
 *     object has no receipt and is refused outright;
 *   - the ADAPTER must be one of the exact instances whose canaries passed —
 *     a different instance sharing the backend name inherits nothing;
 *   - the LAUNCH FUNCTION must still be the reference the canaries exercised —
 *     swapping adapter.launch after certification is detected and refused
 *     (delta review 3);
 *   - the requested posture must match the demonstrated posture, and a
 *     proxy stand-in observations never authorize production proxy launches.
 *     Their endpoint identity and upstream allowlist are not certified.
 * Every refusal names its own failure plus the resolver's config hint, so a
 * missing backend can never degrade into a host shell.
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
  // Snapshot BEFORE any validation (delta review round 2): every check below
  // and the adapter launch read THIS frozen copy, so a getter that returns
  // different values across reads cannot validate one posture and launch
  // another.  An omitted parentEnv is captured here too — the adapter must
  // never fall back to the live, mutable process.env after an await.
  const snapshot: Parameters<SandboxBackendAdapter['launch']>[0] = Object.freeze({
    workspace: request.workspace,
    argv: Object.freeze([...request.argv]),
    parentEnv: Object.freeze({
      ...(request.parentEnv ?? { ...process.env }),
    }) as Readonly<Record<string, string | undefined>>,
    ...(request.envPassthrough !== undefined
      ? { envPassthrough: Object.freeze([...request.envPassthrough]) }
      : {}),
    network: request.network,
    ...(request.proxyPort !== undefined ? { proxyPort: request.proxyPort } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.maxOutputChars !== undefined ? { maxOutputChars: request.maxOutputChars } : {}),
  });
  const receipt = probeReceipts.get(certification);
  if (receipt === undefined) {
    throw new Error(
      'sandbox: certification was not produced by the RS-13 probe; a caller-forged certification object cannot authorize a launch',
    );
  }
  const probed = receipt.probedAdapters.get(adapter);
  if (probed === undefined) {
    throw new Error(
      `sandbox: this ${adapter.backend} launcher object was not probed by this certification — ` +
        'a receipt binds the exact adapter instances it probed, and a different instance ' +
        'sharing the backend name inherits nothing; CQ_SANDBOX=required is fail-closed',
    );
  }
  // The receipt binds the EXACT launch function the canaries exercised
  // (delta review 3): replacing adapter.launch after certification — e.g.
  // with a grant-all — is detected and refused, never inherited.
  if (probed.launch !== adapter.launch) {
    throw new Error(
      `sandbox: this ${adapter.backend} launcher's launch method changed after certification; ` +
        'the receipt authorizes only the function the canaries exercised; ' +
        'CQ_SANDBOX=required is fail-closed',
    );
  }
  if (probed.blocker !== '') {
    throw new Error(
      `sandbox: ${adapter.backend} is not certified for required mode (${probed.blocker}); ` +
        'CQ_SANDBOX=required is fail-closed until a certified backend launcher is configured',
    );
  }
  if (snapshot.network !== receipt.network) {
    throw new Error(
      `sandbox: ${adapter.backend} was certified under the '${receipt.network}' posture, ` +
        `not the requested '${snapshot.network}'; certification does not transfer across postures ` +
        'and CQ_SANDBOX=required is fail-closed',
    );
  }
  const proxyDemonstrated = receipt.networkDemonstrated === 'proxy-loopback';
  if (proxyDemonstrated) {
    throw new Error(
      'sandbox: proxy stand-in observations cannot authorize a production endpoint identity or upstream allowlist; CQ_SANDBOX=required is fail-closed',
    );
  }
  if ((snapshot.proxyPort !== undefined) !== proxyDemonstrated) {
    throw new Error(
      `sandbox: ${adapter.backend} was certified with '${receipt.networkDemonstrated}' egress; ` +
        (proxyDemonstrated
          ? 'a proxyPort is required on every launch'
          : 'proxyPort is not permitted on a launch certified without a proxy') +
        ' — the launch profile must be the profile the canaries proved; CQ_SANDBOX=required is fail-closed',
    );
  }
  // Invoke the receipt-bound reference, never a second read of
  // `adapter.launch` (an accessor could return a different function).
  return probed.launch.call(adapter, snapshot);
}
