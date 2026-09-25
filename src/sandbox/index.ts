// Sandbox launcher helpers.  Backend launchers receive this scrubbed
// environment; CQ_* policy knobs are intentionally absent so a model-directed
// child cannot reconfigure its own boundary.
import type { SandboxConfig } from './config.js';

const SAFE_ENV = new Set(['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'TMPDIR']);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build a launcher environment from a parent environment.  The default
 * allowlist is intentionally small; deployment-specific names must be named
 * by CQ_RUN_ENV_PASSTHROUGH and are copied only when valid.
 */
export function buildSandboxLauncherEnv(
  parent: Readonly<Record<string, string | undefined>>,
  config: Pick<SandboxConfig, 'envPassthrough'>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (SAFE_ENV.has(name) && value !== undefined) out[name] = value;
  }
  for (const name of config.envPassthrough) {
    if (!ENV_NAME.test(name) || name.startsWith('CQ_')) {
      throw new Error(`sandbox: launcher env passthrough '${name}' is not permitted`);
    }
    const value = parent[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export * from './config.js';
