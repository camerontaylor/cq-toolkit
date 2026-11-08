// CQ sandbox policy and certified-backend selection (D14 / W1.11).
//
// The resolver is deliberately pure: callers pass the environment and the
// platform's certified backend probe result.  A missing probe is a missing
// certification, never an invitation to run an unverified launcher.

import {
  SANDBOX_POLICY_ENV_NAMES,
  parseBackend,
  parseMode,
  parseNetwork,
  parsePassthrough,
  parseRunTool,
  type SandboxBackend,
  type SandboxMode,
  type SandboxNetwork,
} from '../config/parsers.js';
import { assertCqEnvName } from '../config/entry.js';
import type { CqEnv } from '../config/env.js';
import { processEnv } from '../config/process-env.js';
import type { CqEnvRegistry } from '../config/env-registry.js';
import { assertOptInAuthority } from '../config/optin.js';

export {
  SANDBOX_POLICY_ENV_NAMES,
  parseBackend,
  parseMode,
  parseNetwork,
  parsePassthrough,
  parseRunTool,
};
export type { SandboxBackend, SandboxMode, SandboxNetwork };

export type SandboxPlatform = 'linux' | 'darwin' | 'other';

export interface SandboxOptIn {
  sandbox?: string;
  'sandbox.backend'?: string;
  'sandbox.network'?: string;
  run?: string;
  'run.envPassthrough'?: string;
}

const SANDBOX_OPT_IN_ENV: Readonly<Record<string, string>> = {
  sandbox: 'CQ_SANDBOX',
  'sandbox.backend': 'CQ_SANDBOX_BACKEND',
  'sandbox.network': 'CQ_SANDBOX_NETWORK',
  run: 'CQ_RUN_TOOL',
  'run.envPassthrough': 'CQ_RUN_ENV_PASSTHROUGH',
};

export interface SandboxConfig {
  mode: SandboxMode;
  backend: SandboxBackend | 'auto';
  /** ADVISORY: the requested egress posture, not an enforced boundary (see SandboxNetwork). */
  network: SandboxNetwork;
  runTool: 'on' | 'off' | 'withheld';
  envPassthrough: readonly string[];
  /** The selected backend, or undefined when none is certified. */
  selectedBackend?: SandboxBackend;
  /** Stable, actionable failure text for operations that require `run`. */
  configHint?: string;
}

export interface ResolveSandboxOptions {
  /**
   * The entry point's CQ_* snapshot. Preferred: its already-parsed values form
   * the env layer. Without it (and without `env`) the process environment is
   * parsed directly, as before.
   */
  cqEnv?: CqEnv;
  env?: Readonly<Record<string, string | undefined>>;
  optIn?: SandboxOptIn;
  /** Registry consulted for the `trust` flag; default the shipped registry (a test seam). */
  registry?: CqEnvRegistry;
  platform?: NodeJS.Platform;
  /** Backends whose launcher passed the RS-13 live boundary probe. */
  certifiedBackends?: readonly SandboxBackend[];
  /** Explicit opt-in for a driver's already-tightened cc-native configuration. */
  driverScopedCcNative?: boolean;
}

const AUTO_ORDER: Readonly<Record<'linux' | 'darwin', readonly SandboxBackend[]>> = {
  linux: ['landlock', 'bwrap', 'container'],
  darwin: ['seatbelt', 'container'],
};

function platformOf(platform: NodeJS.Platform): SandboxPlatform {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  return 'other';
}

/**
 * Resolve project env, then explicit per-call opt-ins, over conservative
 * built-ins.  `cc-native` is deliberately not in AUTO_ORDER: it is valid only
 * for a driver-scoped tightened configuration, never as a shipped default.
 */
export function resolveSandboxConfig(options: ResolveSandboxOptions = {}): SandboxConfig {
  const env = options.env ?? processEnv();
  const typed = options.cqEnv?.values;
  const optIn = options.optIn ?? {};
  assertOptInAuthority('sandbox', optIn, SANDBOX_OPT_IN_ENV, options.registry);
  // optIn beats the env layer; the env layer is the snapshot's parsed value
  // when one was passed, else the raw process/explicit env parsed here.
  const layered = <T>(
    optInRaw: string | undefined,
    parse: (raw: string | undefined) => T,
    name: string,
  ): T =>
    optInRaw !== undefined
      ? parse(optInRaw)
      : typed !== undefined && options.cqEnv !== undefined
        ? (assertCqEnvName(options.cqEnv, 'sandbox', name),
          (typed[name] as T | undefined) ?? parse(undefined))
        : parse(env[name]);
  const mode = layered(optIn.sandbox, parseMode, 'CQ_SANDBOX');
  const backend = layered(optIn['sandbox.backend'], parseBackend, 'CQ_SANDBOX_BACKEND') ?? 'auto';
  if (backend === 'cc-native' && options.driverScopedCcNative !== true) {
    throw new Error(
      'sandbox: cc-native is driver-scoped only; it cannot be selected by the shipped CQ_SANDBOX config',
    );
  }
  const network = layered(optIn['sandbox.network'], parseNetwork, 'CQ_SANDBOX_NETWORK');
  const requestedRunTool = layered(optIn.run, parseRunTool, 'CQ_RUN_TOOL');
  const envPassthrough = layered(
    optIn['run.envPassthrough'],
    parsePassthrough,
    'CQ_RUN_ENV_PASSTHROUGH',
  );

  const platform = platformOf(options.platform ?? process.platform);
  const certified = new Set(options.certifiedBackends ?? []);
  const autoOrder = platform === 'other' ? [] : AUTO_ORDER[platform];
  if (backend !== 'auto' && !autoOrder.includes(backend) && backend !== 'cc-native') {
    throw new Error(
      `sandbox: backend '${backend}' is not available on ${platform}; choose an RS-13 certified backend or auto`,
    );
  }
  if (backend !== 'auto' && !certified.has(backend)) {
    throw new Error(
      `sandbox: backend '${backend}' is not certified for this platform; choose an RS-13 certified backend or auto`,
    );
  }
  const selected =
    backend === 'auto' ? autoOrder.find((candidate) => certified.has(candidate)) : backend;
  const noBackend = mode === 'required' && selected === undefined;
  const requiredLauncherUnavailable = mode === 'required';
  const configHint =
    noBackend || requiredLauncherUnavailable
      ? 'CQ_SANDBOX=required is fail-closed until a certified backend launcher is configured; set CQ_SANDBOX=off to use the host command allowlist with env scrub'
      : undefined;

  return {
    mode,
    backend,
    network,
    // Required mode remains withheld even when backend certification is known:
    // the current harness has no certified launcher.  Exposing `run` here
    // would silently turn the model-selected shell into a host shell.
    runTool: requestedRunTool === 'off' ? 'off' : requiredLauncherUnavailable ? 'withheld' : 'on',
    envPassthrough,
    ...(selected !== undefined ? { selectedBackend: selected } : {}),
    ...(configHint !== undefined ? { configHint } : {}),
  };
}

/** True when `run` is available under the resolved policy. */
export function runToolAvailable(config: SandboxConfig): boolean {
  return config.runTool === 'on';
}

/** Throw the stable configuration hint before an operation that needs `run`. */
export function assertRunToolAvailable(config: SandboxConfig): void {
  if (runToolAvailable(config)) return;
  throw new Error(
    config.configHint ??
      'sandbox: the run tool is disabled; set CQ_RUN_TOOL=on only with CQ_SANDBOX=off or a certified backend',
  );
}

/** The certified `auto` order for a platform, exposed for diagnostics/tests. */
export function certifiedAutoOrder(platform: NodeJS.Platform): readonly SandboxBackend[] {
  const key = platformOf(platform);
  return key === 'other' ? [] : AUTO_ORDER[key];
}
