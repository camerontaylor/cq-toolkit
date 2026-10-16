// Shipped sandbox backends retained by the core package: OCI container and
// optional Landlock helper. Host-native seatbelt/bwrap launchers and the
// certification probe live under experimental/sandbox-host.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launcherEnv,
  launcherInsideWorkspace,
  pathInsideWorkspace,
  resolveLauncher,
  runChild,
} from './launcher.js';
import type { SandboxBackend, SandboxNetwork } from './config.js';
import type { SandboxBackendAdapter, SandboxLaunchResult } from './launcher.js';
export type { SandboxBackendAdapter, SandboxLaunchResult } from './launcher.js';

// ---------------------------------------------------------------------------
// container — OCI runtime (docker/podman CLI), strictest out of the box
// ---------------------------------------------------------------------------

/**
 * The default container image (Codex P2 on #244, owner ruling): a plain
 * installation used to name a `cq-sandbox` image nobody ships, so the
 * container fallback failed closed on every host that had not hand-built
 * one.  The default is now the official Docker Hub `node` slim image for the
 * Node line this repo targets (CI setup-node 24), pinned by its MULTI-ARCH
 * INDEX digest — one immutable reference that resolves to the same bytes on
 * linux/amd64 and linux/arm64, so no mutable tag can silently re-target the
 * certified boundary and no per-arch digest table is needed.  The image
 * carries bash + coreutils (every certification canary executes on them)
 * plus node and corepack (pnpm via the project's `packageManager` pin); git
 * deliberately stays out — git operations run on the host, outside the
 * model-directed child.  Bumping is a one-line digest refresh; the procedure
 * lives in docs/sandbox-container-image.md.
 */
export const DEFAULT_SANDBOX_IMAGE =
  'node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';

/** A reference is digest-pinned when it ends in an immutable sha256 digest. */
const DIGEST_PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/;

/**
 * Validated at construction like `--user` (delta review P2): the image rides
 * as a bare argv position after the fixed boundary flags, so a reference
 * with whitespace/control characters or a leading `-` could ride as CLI
 * flags instead of an image.  An override is digest-pinned by default — a
 * mutable tag would let the image content change between the certification
 * probe and a later launch while the receipt still names the old reference —
 * and `allowUnpinnedImage` is the explicit opt-out for bring-your-own
 * references a daemon can only resolve as a tag (e.g. a locally built image
 * no registry has a digest for).
 */
function validatedContainerImage(image: string, allowUnpinned: boolean): string {
  if (image === '' || /[\s\0]/.test(image) || image.startsWith('-')) {
    throw new Error(
      `sandbox: container image '${image}' must be a plain reference; whitespace, control characters, and a leading dash are refused (the image is a bare argv position, not a flag slot)`,
    );
  }
  if ((image.match(/@/g) ?? []).length > 1) {
    throw new Error(`sandbox: container image '${image}' carries more than one '@'`);
  }
  if (!DIGEST_PINNED_IMAGE.test(image) && !allowUnpinned) {
    throw new Error(
      `sandbox: container image '${image}' is not digest-pinned; pass 'name:tag@sha256:<64 hex>' so a mutable tag cannot silently re-target the certified boundary, or set allowUnpinnedImage to accept an unpinned reference explicitly`,
    );
  }
  return image;
}

export interface ContainerAdapterOptions {
  /**
   * Image to run; defaults to DEFAULT_SANDBOX_IMAGE (digest-pinned official
   * node slim).  A container backend without any image is not provisionable;
   * a default keeps that claim honest without naming a phantom image.
   */
  image?: string;
  /**
   * Explicitly accept a non-digest-pinned `image` override.  Default false:
   * the certified boundary binds an immutable digest, and relaxing that
   * takes a named opt-in, like every other loosening here.
   */
  allowUnpinnedImage?: boolean;
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
 * here.  The child env arrives through `--env-file` (a private 0600 file
 * written by `launch`), so env VALUES never appear in argv, where any local
 * user could read them, and never enter the container CLI's OWN environment
 * (Codex P1): a passthrough `DOCKER_HOST`, `HOME`, or `PATH` would otherwise
 * retarget the daemon, config, or credential helpers the probe certified.
 * `--entrypoint` pins `argv[0]` (Codex P2): an image ENTRYPOINT would
 * otherwise receive the request argv as arguments instead of executing it.
 * The image reference is validated (`validatedContainerImage`): it rides as
 * a bare argv position, so a flag-shaped or unpinned reference is refused —
 * the digest-pinned DEFAULT_SANDBOX_IMAGE unless an override says otherwise.
 */
export function containerArgv(
  options: ContainerAdapterOptions,
  workspace: string,
  network: SandboxNetwork,
  envFile: string,
  argv: readonly string[],
): string[] {
  const image = validatedContainerImage(
    options.image ?? DEFAULT_SANDBOX_IMAGE,
    options.allowUnpinnedImage === true,
  );
  const [entrypoint, ...args] = argv;
  if (entrypoint === undefined || entrypoint === '' || entrypoint.startsWith('-')) {
    throw new Error(`sandbox: container argv[0] must be a command, got '${String(entrypoint)}'`);
  }
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
    '--env-file',
    envFile,
    `--entrypoint=${entrypoint}`,
    image,
    ...args,
  ];
}

/**
 * Serialize the child env for `--env-file`.  The format is one `NAME=value`
 * per line with no escaping, so a value carrying a line break or NUL cannot
 * be represented faithfully: `undefined` (the caller refuses the launch)
 * rather than a silently altered environment.
 */
export function containerEnvFile(env: Readonly<Record<string, string>>): string | undefined {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (/[\n\r\0]/.test(value)) return undefined;
    lines.push(`${name}=${value}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Control-plane CLI budget (create/inspect/rm), independent of the child's. */
const CONTAINER_CONTROL_TIMEOUT_MS = 15_000;

export function containerAdapter(options: ContainerAdapterOptions = {}): SandboxBackendAdapter {
  const backend: SandboxBackend = 'container';
  // Snapshot and freeze EVERY launch-relevant option at construction (Sol
  // final-head review): the adapter must never read caller-owned mutable
  // state after certification, or mutating options.command/image/user would
  // change the executable while adapter.launch stays identity-fixed and the
  // receipt cannot see it.  Validation also happens HERE, so a root --user
  // or an unpinned image override is refused before any probe, not just at
  // launch; an absent image resolves to DEFAULT_SANDBOX_IMAGE.
  const resolved = Object.freeze({
    command: options.command ?? 'docker',
    image: validatedContainerImage(
      options.image ?? DEFAULT_SANDBOX_IMAGE,
      options.allowUnpinnedImage === true,
    ),
    // The allowance rides the snapshot: launch re-validates the frozen image
    // through containerArgv, and it must see the SAME policy construction
    // accepted, not a re-derived stricter one.
    allowUnpinnedImage: options.allowUnpinnedImage === true,
    user: validatedContainerUser(options.user),
  });
  // The CLI binary is fixed at construction (final-head review): a bare name
  // is resolved to its absolute path ONCE here, so a launch request carrying
  // a parentEnv with a different PATH — one pointing into the workspace —
  // cannot select a different executable after certification.
  const launcher = resolveLauncher(resolved.command);
  // The CLI's OWN environment is fixed at construction too (Codex P1): the
  // daemon, context, config dir, and credential helpers it selects come from
  // the adapter process — exactly what availability and the canaries ran
  // under — never from a request's parentEnv or passthrough names.
  const cliEnv = Object.freeze(launcherEnv({}));
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
        env: { ...cliEnv },
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
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
      const containerInside = launcherInsideWorkspace(launcher, request.workspace);
      if (containerInside !== undefined) return containerInside;
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
      const refusal = (message: string): SandboxLaunchResult => ({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: message,
      });
      const envFileText = containerEnvFile(launcherEnv(request));
      if (envFileText === undefined) {
        return refusal(
          'container child env holds a value with a line break or NUL; --env-file cannot carry it faithfully',
        );
      }
      const [entrypoint] = request.argv;
      if (entrypoint === undefined || entrypoint === '' || entrypoint.startsWith('-')) {
        return refusal(`container argv[0] must be a command, got '${String(entrypoint)}'`);
      }
      // Create without executing first: a timed-out `docker run` can leave
      // its daemon-owned child alive after the CLI dies. Only start an ID
      // returned by a completed create, and forcibly remove that exact ID
      // after EVERY attach outcome (including timeout/output overflow).
      const name = `cq-sandbox-${randomUUID()}`;
      const childOptions = {
        cwd: request.workspace,
        env: { ...cliEnv },
        timeoutMs: request.timeoutMs ?? 30_000,
        maxOutputChars: request.maxOutputChars ?? 64 * 1024,
      };
      // Control-plane calls get their own fixed budget (rationing P0): the
      // request budget bounds the ATTACHED child only, so a short attach
      // deadline can never cut off `create` before an ID exists.
      const controlOptions = {
        ...childOptions,
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
        maxOutputChars: 4_000,
      };
      // The env file lives in a fresh 0700 directory OUTSIDE the workspace
      // and exists only while `create` reads it — it is gone before any
      // child of this launch can start.
      const envDir = await mkdtemp(join(tmpdir(), 'cq-ctr-env-'));
      if (pathInsideWorkspace(envDir, request.workspace)) {
        await rm(envDir, { recursive: true, force: true });
        return refusal(
          'the container env-file directory resolves inside the model-writable workspace; refusing',
        );
      }
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
        let created: SandboxLaunchResult;
        try {
          const envFile = join(envDir, 'child.env');
          await writeFile(envFile, envFileText, { mode: 0o600 });
          const createArgs = containerArgv(
            resolved,
            request.workspace,
            request.network,
            envFile,
            request.argv,
          ).slice(3); // omit `<cli> run --rm`
          created = await runChild(
            launcher,
            ['create', '--name', name, ...createArgs],
            controlOptions,
          );
        } finally {
          await rm(envDir, { recursive: true, force: true });
        }
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
              controlOptions,
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
        // --volumes also removes anonymous volumes an image VOLUME declared
        // (Codex P2): create + manual rm does not get `run --rm`'s cleanup.
        const removed = await runChild(
          launcher,
          ['rm', '--force', '--volumes', identity],
          controlOptions,
        );
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
      const helperInside = launcherInsideWorkspace(helperPath, request.workspace);
      if (helperInside !== undefined) return helperInside;
      if (request.proxyPort !== undefined) {
        // The helper has no proxy-port argument; refuse rather than run a
        // different egress posture than the one requested.
        return {
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError:
            'landlock cannot compose a loopback proxy under model-only; proxyPort is unsupported',
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
