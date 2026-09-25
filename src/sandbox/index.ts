// Sandbox launcher helpers.  Backend launchers receive this scrubbed
// environment; CQ_* policy knobs are intentionally absent so a model-directed
// child cannot reconfigure its own boundary.
import { resolveSandboxConfig, SANDBOX_POLICY_ENV_NAMES } from './config.js';
import type { SandboxConfig } from './config.js';

const SAFE_ENV = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'Path',
  'SHELL',
  'TERM',
  'TMPDIR',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build a launcher environment from a parent environment.  The default
 * allowlist is intentionally small; deployment-specific names must be named
 * by CQ_RUN_ENV_PASSTHROUGH (`envPassthrough`) or by a harness manifest
 * (`declaredEnvNames`), and are copied only when valid.  A sandbox POLICY KNOB
 * name is never copied on either path: a child that could read it could steer
 * its own boundary, so declaring one throws instead of leaking.
 */
export function buildSandboxLauncherEnv(
  parent: Readonly<Record<string, string | undefined>>,
  config: {
    envPassthrough: readonly string[];
    declaredEnvNames?: readonly string[] | undefined;
  },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (SAFE_ENV.has(name) && value !== undefined) out[name] = value;
  }
  for (const [name, origin] of [
    ...config.envPassthrough.map((name) => [name, 'passthrough'] as const),
    ...(config.declaredEnvNames ?? []).map((name) => [name, 'declared'] as const),
  ]) {
    if (!ENV_NAME.test(name) || SANDBOX_POLICY_ENV_NAMES.has(name)) {
      throw new Error(`sandbox: launcher env ${origin} name '${name}' is not permitted`);
    }
    const value = parent[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shared run gate — ONE seam every harness surface applies
// ---------------------------------------------------------------------------

/**
 * What a worker harness surface must do with its `run` tool. Plain data, so
 * the gate travels the same way a HarnessConfig does.
 *
 *   - `enabled: false` — `run` is OMITTED from the surface entirely: a
 *     withheld tool can never be reached, so no host command runs.
 *   - `envPassthrough` — the ONLY parent env NAMES copied into a run child
 *     beyond the launcher defaults; a `CQ_*` name is never permitted there.
 *   - `declaredEnvNames` — extra names a harness MANIFEST declared for its run
 *     children (`HarnessManifest.envNames`, the pre-W1.11 default-deny
 *     allowlist on the MCP/subprocess surface). Merged after the launcher
 *     scrub; a policy knob name is still rejected rather than leaked.
 */
export interface HarnessRunGate {
  enabled: boolean;
  envPassthrough: readonly string[];
  declaredEnvNames?: readonly string[];
  /** Stable, actionable text for a withheld gate; undefined when enabled. */
  configHint?: string;
}

/** The CQ_SANDBOX / CQ_SANDBOX_* / CQ_RUN_TOOL env names that express a policy. */
const POLICY_ENV_NAMES = SANDBOX_POLICY_ENV_NAMES;

/**
 * The gate the harness `buildTools` seam applies when the caller names none.
 *
 * D14 makes worker isolation OPT-IN: an operator that sets any sandbox knob
 * gets the fail-closed policy (resolved by `resolveSandboxConfig`, whose
 * blank→`required` posture withholds `run` until a certified launcher exists)
 * on EVERY harness surface — the ai-sdk driver, the subprocess driver's
 * `buildTools` surface, and the MCP harness surface all resolve this one
 * function, so a required policy cannot be bypassed by choosing a driver. An
 * environment that names no sandbox knob keeps the pre-W1.11 behaviour: the
 * run tool exists and the harness allowlist is its only gate.
 */
export function harnessRunGate(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    sandboxConfig?: SandboxConfig;
  } = {},
): HarnessRunGate {
  const env = options.env ?? process.env;
  if (options.sandboxConfig === undefined) {
    const expressed = [...POLICY_ENV_NAMES].some(
      (name) => Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined,
    );
    if (!expressed) return { enabled: true, envPassthrough: [] };
  }
  const config = options.sandboxConfig ?? resolveSandboxConfig({ env });
  return {
    enabled: config.runTool === 'on',
    envPassthrough: config.envPassthrough,
    ...(config.configHint !== undefined ? { configHint: config.configHint } : {}),
  };
}

export * from './config.js';
