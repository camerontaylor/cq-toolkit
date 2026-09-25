// CQ sandbox policy and certified-backend selection (D14 / W1.11).
//
// The resolver is deliberately pure: callers pass the environment and the
// platform's certified backend probe result.  A missing probe is a missing
// certification, never an invitation to run an unverified launcher.

export type SandboxMode = 'off' | 'required';
/**
 * The requested egress posture of a sandboxed run child.
 *
 * ADVISORY IN v1: nothing enforces this value. There is no transport
 * boundary — no proxy, netfilter, or loopback-only launcher — in front of a
 * `run` child, so 'model-only' records the INTENDED posture for a future
 * certified launcher; it is never a claim that egress is restricted today.
 * `run` is instead fail-closed outright while no launcher exists.
 */
export type SandboxNetwork = 'model-only' | 'allow';
export type SandboxBackend = 'landlock' | 'bwrap' | 'container' | 'seatbelt' | 'cc-native';
export type SandboxPlatform = 'linux' | 'darwin' | 'other';

export interface SandboxOptIn {
  sandbox?: string;
  'sandbox.backend'?: string;
  'sandbox.network'?: string;
  run?: string;
  'run.envPassthrough'?: string;
}

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
  env?: Readonly<Record<string, string | undefined>>;
  optIn?: SandboxOptIn;
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

const BACKENDS = new Set<SandboxBackend>([
  'landlock',
  'bwrap',
  'container',
  'seatbelt',
  'cc-native',
]);

const ENV_NAMES = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Policy controls must never be copied into a model-directed child. */
export const SANDBOX_POLICY_ENV_NAMES: ReadonlySet<string> = new Set([
  'CQ_SANDBOX',
  'CQ_SANDBOX_BACKEND',
  'CQ_SANDBOX_NETWORK',
  'CQ_RUN_TOOL',
  'CQ_RUN_ENV_PASSTHROUGH',
]);

function platformOf(platform: NodeJS.Platform): SandboxPlatform {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  return 'other';
}

function parseBackend(raw: string | undefined): SandboxBackend | 'auto' | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw === 'auto') return 'auto';
  if (!BACKENDS.has(raw as SandboxBackend)) {
    throw new Error(
      `sandbox: uncertified backend '${raw}' (use auto or a RS-13 certified backend)`,
    );
  }
  return raw as SandboxBackend;
}

function parseMode(raw: string | undefined): SandboxMode {
  if (raw === undefined || raw.trim() === '') return 'required';
  if (raw === 'off' || raw === 'required') return raw;
  throw new Error(`sandbox: CQ_SANDBOX must be 'off' or 'required', got '${raw}'`);
}

function parseNetwork(raw: string | undefined): SandboxNetwork {
  if (raw === undefined || raw.trim() === '') return 'model-only';
  if (raw === 'model-only' || raw === 'allow') return raw;
  throw new Error(`sandbox: CQ_SANDBOX_NETWORK must be 'model-only' or 'allow', got '${raw}'`);
}

function parseRunTool(raw: string | undefined): 'on' | 'off' {
  if (raw === undefined || raw.trim() === '') return 'on';
  if (raw === 'on' || raw === 'off') return raw;
  throw new Error(`sandbox: CQ_RUN_TOOL must be 'on' or 'off', got '${raw}'`);
}

function parsePassthrough(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    if (!ENV_NAMES.test(name)) {
      throw new Error(`sandbox: CQ_RUN_ENV_PASSTHROUGH contains invalid env name '${name}'`);
    }
    if (SANDBOX_POLICY_ENV_NAMES.has(name)) {
      throw new Error(`sandbox: CQ_RUN_ENV_PASSTHROUGH may not expose policy env '${name}'`);
    }
  }
  return [...new Set(names)];
}

/**
 * Resolve project env, then explicit per-call opt-ins, over conservative
 * built-ins.  `cc-native` is deliberately not in AUTO_ORDER: it is valid only
 * for a driver-scoped tightened configuration, never as a shipped default.
 */
export function resolveSandboxConfig(options: ResolveSandboxOptions = {}): SandboxConfig {
  const env = options.env ?? process.env;
  const optIn = options.optIn ?? {};
  const mode = parseMode(optIn.sandbox ?? env['CQ_SANDBOX']);
  const backend = parseBackend(optIn['sandbox.backend'] ?? env['CQ_SANDBOX_BACKEND']) ?? 'auto';
  if (backend === 'cc-native' && options.driverScopedCcNative !== true) {
    throw new Error(
      'sandbox: cc-native is driver-scoped only; it cannot be selected by the shipped CQ_SANDBOX config',
    );
  }
  const network = parseNetwork(optIn['sandbox.network'] ?? env['CQ_SANDBOX_NETWORK']);
  const requestedRunTool = parseRunTool(optIn.run ?? env['CQ_RUN_TOOL']);
  const envPassthrough = parsePassthrough(
    optIn['run.envPassthrough'] ?? env['CQ_RUN_ENV_PASSTHROUGH'],
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
