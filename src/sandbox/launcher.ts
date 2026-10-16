// Shared backend contracts and process-launch safeguards.
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** Post-exit pipe-drain grace when the direct child exits at its deadline. */
const DRAIN_GRACE_MS = 1_000;

/**
 * Run a launcher child to settlement and classify what happened.  The child
 * gets its OWN PROCESS GROUP (final-head review): on timeout the group is
 * SIGKILLed, and after the direct child exits the group is swept once more —
 * an execFile-based predecessor killed only the direct child, so a background
 * grandchild with inherited stdio pipes survived the launch (and kept the
 * launch's result from settling until it happened to exit).  `ok` means the
 * child exited 0; a launcher that could not spawn says so via `spawnError`.
 */
export function runChild(
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
    let settled = false;
    const deadline = Date.now() + options.timeoutMs;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      // Sweep the group the moment the DIRECT child is gone (delta review):
      // descendants holding the stdio pipes would otherwise delay settlement
      // until the timeout.  The child has EXITED — stop the timeout clock so
      // a slow pipe drain can neither signal a vanished (possibly recycled)
      // group nor misclassify an exited child as timed out (round-3 review).
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!spawnErrored) killGroup('SIGKILL');
      // A descendant that LEFT the group (setsid) survives the sweep and can
      // hold the stdio pipes open indefinitely, so 'close' never fires and
      // the launch would never settle (Opus review).  Bound the drain by the
      // launch deadline (with a short grace for a legitimate tail): then the
      // pipes are destroyed and the launch is not ok — its output is
      // incomplete and a process outlived the sweep.
      drainTimer = setTimeout(
        () => {
          if (finished) return;
          result.timedOut = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
        },
        Math.max(deadline - Date.now(), DRAIN_GRACE_MS),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      result.timedOut = true;
      killGroup('SIGKILL');
    }, options.timeoutMs);
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle();
      clearTimeout(drainTimer);
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
      // After settlement the child is gone — late buffered chunks must not
      // signal a recycled group or re-mark the result.
      if (overflowed && !settled) {
        result.timedOut = true;
        killGroup('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = capture(err, chunk, errBytes);
      errBytes = Math.min(errBytes + chunk.byteLength, captureCap);
      if (overflowed && !settled) {
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
export function resolveLauncher(name: string): string | undefined {
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

/** Dynamic-loader hook names: run code inside a launcher before any boundary exists. */
const LOADER_HOOK_NAME = /^(?:LD_|DYLD_)/;

/**
 * Build the launcher child env from the parent env through the shared scrub.
 * The launcher (bwrap, sandbox-exec, a container CLI, the Landlock helper) runs
 * on the HOST before the boundary is installed, so an operator passthrough
 * naming a loader hook (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, ...) would run
 * a model-writable library unconfined.  Loader hooks are categorically
 * excluded from this env, passthrough or not.
 */
export function launcherEnv(request: {
  parentEnv?: Readonly<Record<string, string | undefined>>;
  envPassthrough?: readonly string[];
}): Record<string, string> {
  const scrubbed = buildSandboxLauncherEnv(request.parentEnv ?? process.env, {
    envPassthrough: request.envPassthrough ?? [],
  });
  for (const name of Object.keys(scrubbed)) {
    if (LOADER_HOOK_NAME.test(name)) delete scrubbed[name];
  }
  return scrubbed;
}

/**
 * Refuse a launcher whose canonical path sits inside the requested workspace:
 * a confined command could replace that file, and the next launch would
 * execute the replacement on the host before any boundary exists.
 */
export function launcherInsideWorkspace(
  launcher: string,
  workspace: string,
): SandboxLaunchResult | undefined {
  if (pathInsideWorkspace(launcher, workspace)) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: `launcher '${launcher}' is inside the model-writable workspace; refusing to execute a replaceable launcher`,
    };
  }
  return undefined;
}

/** Whether `path` canonically resolves to or under the canonical workspace. */
export function pathInsideWorkspace(path: string, workspace: string): boolean {
  let real: string;
  let realWorkspace: string;
  try {
    real = realpathSync(path);
    realWorkspace = realpathSync(workspace);
  } catch {
    return false; // an unresolvable path fails at spawn / workspace validation
  }
  const rel = relative(realWorkspace, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
