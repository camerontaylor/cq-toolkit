// The RS-13 live boundary probe (B14): a backend is certified ONLY when real
// canaries executed inside its launcher demonstrate the boundary, and every
// positive control proves the canary ran for real.  There is no synthetic
// pass: a launcher that blocks everything fails its controls and stays
// uncertified; a backend that cannot run at all records the exact
// environmental blocker and stays uncertified; an inconclusive canary
// (control failed) also refuses certification — doubt fails closed.
//
// The certified list this module emits is the ONLY intended source for
// `resolveSandboxConfig({ certifiedBackends })`; `certifiedBackendsOf` types
// that handoff so no caller can name a backend the probe never ran.
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer, type AddressInfo } from 'node:net';

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
  | 'write-escape'
  | 'credential-env'
  | 'credential-file'
  | 'network-loopback';

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
  records: BackendProbeRecord[];
  certified: readonly SandboxBackend[];
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Adapters to probe; defaults to the platform's `auto` candidates. */
  adapters?: readonly SandboxBackendAdapter[];
  network?: SandboxNetwork;
  timeoutMs?: number;
}

interface ProbeScratch {
  root: string;
  workspace: string;
}

async function withScratch<T>(
  adapter: SandboxBackendAdapter,
  run: (scratch: ProbeScratch) => Promise<T>,
): Promise<T> {
  // The escape canaries target the parent's own temp dir: on darwin that is a
  // user-data zone the profile denies (/private/var/folders); under bwrap or
  // a container it is simply never mounted inside.  The workspace lives in
  // the adapter's runnable parent, so the workspace controls stay positive.
  const root = await mkdtemp(join(tmpdir(), 'cq-sbx-root-'));
  const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-ws-'));
  try {
    return await run({ root, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
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
 * Probe ONE adapter with the live canaries.  Every canary that asserts a
 * denial has a positive control somewhere — either the workspace controls
 * inside the same launcher or the bare-host twin beside it — so a launcher
 * that fails wholesale cannot masquerade as confinement.
 */
export async function probeBackend(
  adapter: SandboxBackendAdapter,
  options: ProbeOptions = {},
): Promise<BackendProbeRecord> {
  const platform = options.platform ?? process.platform;
  const network = options.network ?? 'model-only';
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = { backend: adapter.backend, platform, network };

  const availability = await adapter.available();
  if (!availability.available) {
    return {
      ...base,
      runnable: false,
      certified: false,
      ...(availability.blocker !== undefined ? { blocker: availability.blocker } : {}),
      canaries: [],
    };
  }

  return withScratch(adapter, async ({ root, workspace }) => {
    const canaries: CanaryOutcome[] = [];
    const secret = `cq-probe-secret-${randomBytes(8).toString('hex')}`;
    const sentinel = join(root, 'cq-sentinel');
    await writeFile(sentinel, 'escape-target');
    const homeCanary = join(homedir(), `.cq-probe-canary-${randomBytes(4).toString('hex')}`);
    await writeFile(homeCanary, 'credential-target');
    const parentEnv: Record<string, string | undefined> = {
      ...process.env,
      CQ_PROBE_CANARY_SECRET: secret,
    };

    const launch = (argv: readonly string[]) =>
      adapter.launch({
        workspace,
        argv,
        parentEnv,
        network,
        timeoutMs,
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

      // 2 — the child must not read outside the workspace.
      const escapeRead = await launch(['/bin/cat', sentinel]);
      canaries.push(
        escapeRead.ok
          ? { id: 'read-escape', verdict: 'fail', detail: `read a file in ${root}` }
          : { id: 'read-escape', verdict: 'pass', detail: detail(escapeRead) },
      );

      // 3 — the child must not write outside the workspace.
      const escapePath = join(root, 'cq-escape');
      const escapeWrite = await launch(['/usr/bin/touch', escapePath]);
      canaries.push(
        escapeWrite.ok
          ? { id: 'write-escape', verdict: 'fail', detail: `created ${escapePath}` }
          : { id: 'write-escape', verdict: 'pass', detail: detail(escapeWrite) },
      );

      // 4 — a parent secret must not reach the child env.  The bare-host
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
            : envRead.spawnError !== undefined
              ? {
                  id: 'credential-env',
                  verdict: 'inconclusive',
                  detail: `printenv did not run: ${envRead.spawnError}`,
                }
              : { id: 'credential-env', verdict: 'pass', detail: detail(envRead) },
      );

      // 5 — the child must not read a credential beside the user's home files.
      const credRead = await launch(['/bin/cat', homeCanary]);
      canaries.push(
        credRead.ok
          ? { id: 'credential-file', verdict: 'fail', detail: `read ${homeCanary}` }
          : { id: 'credential-file', verdict: 'pass', detail: detail(credRead) },
      );

      // 6 — network: the loopback listener must be connectable on the bare
      // host (control); a model-only boundary must refuse the child's
      // connect, an allow posture must pass it.  Either way this loopback
      // check never claims general egress isolation.
      const expectConnect = network === 'allow';
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
          const connect = ['--norc', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`];
          const control = await hostExec(['/bin/bash', ...connect]);
          const sandboxed = await launch(['/bin/bash', ...connect]);
          if (!control.ok) {
            canaries.push({
              id: 'network-loopback',
              verdict: 'inconclusive',
              detail: `bare-host connect failed, canary cannot fire: ${control.stderr}`,
            });
          } else if (sandboxed.ok !== expectConnect) {
            canaries.push({
              id: 'network-loopback',
              verdict: 'fail',
              detail: expectConnect
                ? `child could not connect to 127.0.0.1:${port} under allow posture`
                : `child connected to 127.0.0.1:${port}`,
            });
          } else {
            // Surface the connect-denial line, not incidental startup noise.
            const denial =
              sandboxed.stderr.split('\n').find((line) => /connect|dev\/tcp|network/i.test(line)) ??
              firstLine(sandboxed.stderr);
            canaries.push({ id: 'network-loopback', verdict: 'pass', detail: denial });
          }
        } finally {
          await listener.close();
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
 * which keeps `CQ_SANDBOX=required` fail-closed.
 */
export async function certifyBackends(options: ProbeOptions = {}): Promise<SandboxCertification> {
  const platform = options.platform ?? process.platform;
  const network = options.network ?? 'model-only';
  const adapters = options.adapters ?? adaptersForPlatform(platform);
  const records: BackendProbeRecord[] = [];
  for (const adapter of adapters) {
    records.push(await probeBackend(adapter, { ...options, platform, network }));
  }
  return {
    platform,
    probedAt: new Date().toISOString(),
    network,
    records,
    certified: records.filter((r) => r.certified).map((r) => r.backend),
  };
}

/** The only certified list a caller may hand to `resolveSandboxConfig`. */
export function certifiedBackendsOf(
  certification: SandboxCertification,
): readonly SandboxBackend[] {
  return certification.certified;
}

/**
 * Required-mode execution primitive: run a command INSIDE a probe-certified
 * backend, or fail closed.  An adapter that was never certified — or whose
 * certification lapsed — throws with the exact blocker plus the resolver's
 * config hint, so a missing backend can never degrade into a host shell.
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
    timeoutMs?: number;
    maxOutputChars?: number;
  },
): Promise<SandboxLaunchResult> {
  if (!certification.certified.includes(adapter.backend)) {
    const record = certification.records.find((r) => r.backend === adapter.backend);
    const blocker = record?.blocker ?? 'backend was not probed by this certification';
    throw new Error(
      `sandbox: ${adapter.backend} is not certified for required mode (${blocker}); ` +
        'CQ_SANDBOX=required is fail-closed until a certified backend launcher is configured',
    );
  }
  return adapter.launch(request);
}
