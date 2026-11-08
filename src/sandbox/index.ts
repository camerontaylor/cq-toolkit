// Sandbox launcher helpers.  Backend launchers receive this scrubbed
// environment; sandbox policy knobs are intentionally absent so a model-directed
// child cannot reconfigure its own boundary.
import { resolveSandboxConfig, SANDBOX_POLICY_ENV_NAMES } from './config.js';
import type { SandboxConfig } from './config.js';
import type { CqEnv } from '../config/env.js';
import {
  DECLARED_ENV_EXEMPT_NAMES,
  TRUSTED_ENV_EXEMPT_NAMES,
  urlValueRefusal,
  credentialRefusal,
  isEnvName,
} from '../config/parsers.js';
import { processEnv } from '../config/process-env.js';

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
  // Non-secret correlation and session-store location, never sandbox policy.
  'CQ_WORK_ID',
  'CQ_PARENT_WORK_ID',
  'CQ_ROLE',
  'CQ_TASK',
  'CQ_RUN_ID',
  'CQ_SESSIONS_DIR',
]);

/**
 * Build a launcher environment from a parent environment.  The default
 * allowlist is intentionally small; deployment-specific names must be named
 * by CQ_RUN_ENV_PASSTHROUGH (`envPassthrough`) or by a harness manifest
 * (`declaredEnvNames`), and are copied only when valid.  A sandbox POLICY KNOB
 * name is never copied on either path: a child that could read it could steer
 * its own boundary, so declaring one throws instead of leaking.
 */
/** A launcher env name was refused (an env refusal, not a surface defect). */
export class LauncherEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LauncherEnvError';
  }
}

export function buildSandboxLauncherEnv(
  parent: Readonly<Record<string, string | undefined>>,
  config: {
    envPassthrough: readonly string[];
    declaredEnvNames?: readonly string[] | undefined;
    trustedEnvNames?: readonly string[] | undefined;
  },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (SAFE_ENV.has(name) && value !== undefined) out[name] = value;
  }
  for (const [name, origin] of [
    ...config.envPassthrough.map((name) => [name, 'passthrough'] as const),
    ...(config.declaredEnvNames ?? []).map((name) => [name, 'declared'] as const),
    ...(config.trustedEnvNames ?? []).map((name) => [name, 'trusted'] as const),
  ]) {
    if (!isEnvName(name)) {
      throw new LauncherEnvError(
        `sandbox: launcher env ${origin} name is not a valid env var name`,
      );
    }
    if (SANDBOX_POLICY_ENV_NAMES.has(name.toUpperCase())) {
      throw new LauncherEnvError(`sandbox: launcher env ${origin} name '${name}' is not permitted`);
    }
    // Every refusal applies to every origin: credential-shaped names and every
    // CQ_* name (the policy knobs were refused above). Each origin has ONE
    // frozen, named exemption list: trusted code-level names may carry
    // SSH_AUTH_SOCK; a manifest file's list is empty; the operator key has none.
    // The trusted origin is names set in-process by trusted code (a driver's
    // `envAllowlist`), never reachable from JSON, a manifest file, a plan or
    // op input.
    const exempt =
      origin === 'trusted'
        ? TRUSTED_ENV_EXEMPT_NAMES
        : origin === 'declared'
          ? DECLARED_ENV_EXEMPT_NAMES
          : [];
    if (!exempt.includes(name)) {
      const credential = credentialRefusal(name);
      if (credential !== undefined) {
        throw new LauncherEnvError(
          origin === 'declared'
            ? `sandbox: launcher env declared name '${name}' is a credential; a declared or manifest name can never pass it (not even SSH_AUTH_SOCK); only the in-process code-level origin may pass SSH_AUTH_SOCK, and the MCP stdio transport refuses it as well`
            : `sandbox: launcher env ${origin} ${credential}`,
        );
      }
      if (name.toUpperCase().startsWith('CQ_')) {
        throw new LauncherEnvError(
          `sandbox: launcher env ${origin} may not expose CQ_* name '${name}'`,
        );
      }
    }
    const value = parent[name];
    if (value !== undefined) {
      const urlRefusal = urlValueRefusal(name, value);
      if (urlRefusal !== undefined)
        throw new LauncherEnvError(`sandbox: launcher env ${origin} ${urlRefusal}`);
    }
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
 *     scrub; a policy knob name is still rejected rather than leaked, and so
 *     is a credential-shaped name (file-supplied names are untrusted data).
 *   - `trustedEnvNames` — names trusted CODE declared in-process (a driver's
 *     `envAllowlist`); exempt from the credential refusal only. Never set from
 *     JSON, a manifest file, a plan or op input.
 */
export interface HarnessRunGate {
  enabled: boolean;
  envPassthrough: readonly string[];
  declaredEnvNames?: readonly string[];
  trustedEnvNames?: readonly string[];
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
    /** The entry point's CQ_* snapshot; takes precedence over `env`. */
    cqEnv?: CqEnv;
    sandboxConfig?: SandboxConfig;
  } = {},
): HarnessRunGate {
  const env = options.env ?? processEnv();
  if (options.sandboxConfig === undefined) {
    const expressed =
      options.cqEnv !== undefined
        ? [...POLICY_ENV_NAMES].some((name) => options.cqEnv?.present.includes(name))
        : [...POLICY_ENV_NAMES].some(
            (name) => Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined,
          );
    if (!expressed) return { enabled: true, envPassthrough: [] };
  }
  const config =
    options.sandboxConfig ??
    resolveSandboxConfig(options.cqEnv !== undefined ? { cqEnv: options.cqEnv } : { env });
  return {
    enabled: config.runTool === 'on',
    envPassthrough: config.envPassthrough,
    ...(config.configHint !== undefined ? { configHint: config.configHint } : {}),
  };
}

export * from './config.js';
