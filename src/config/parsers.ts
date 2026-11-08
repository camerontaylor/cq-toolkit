// Value parsers for the env registry. They live in src/config (below sandbox,
// selfhost, ops and driver) so the registry imports nothing from those layers
// and a later value-import of readCqEnv by sandbox/selfhost cannot form a cycle.
// The original modules re-export these, so existing callers are unchanged.

import { isSecretEnvName } from './secret.js';
import { urlValueRefused } from '../shared/urlRedact.js';

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

const BACKENDS = new Set<SandboxBackend>([
  'landlock',
  'bwrap',
  'container',
  'seatbelt',
  'cc-native',
]);

/** Policy controls must never be copied into a model-directed child. */
export const SANDBOX_POLICY_ENV_NAMES: ReadonlySet<string> = new Set([
  'CQ_SANDBOX',
  'CQ_SANDBOX_BACKEND',
  'CQ_SANDBOX_NETWORK',
  'CQ_RUN_TOOL',
  'CQ_RUN_ENV_PASSTHROUGH',
]);

export function parseBackend(raw: string | undefined): SandboxBackend | 'auto' | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw === 'auto') return 'auto';
  if (!BACKENDS.has(raw as SandboxBackend)) {
    throw new Error(
      `sandbox: uncertified backend '${raw}' (use auto or a RS-13 certified backend)`,
    );
  }
  return raw as SandboxBackend;
}

export function parseMode(raw: string | undefined): SandboxMode {
  if (raw === undefined || raw.trim() === '') return 'required';
  if (raw === 'off' || raw === 'required') return raw;
  throw new Error(`sandbox: CQ_SANDBOX must be 'off' or 'required', got '${raw}'`);
}

export function parseNetwork(raw: string | undefined): SandboxNetwork {
  if (raw === undefined || raw.trim() === '') return 'model-only';
  if (raw === 'model-only' || raw === 'allow') return raw;
  throw new Error(`sandbox: CQ_SANDBOX_NETWORK must be 'model-only' or 'allow', got '${raw}'`);
}

export function parseRunTool(raw: string | undefined): 'on' | 'off' {
  if (raw === undefined || raw.trim() === '') return 'on';
  if (raw === 'on' || raw === 'off') return raw;
  throw new Error(`sandbox: CQ_RUN_TOOL must be 'on' or 'off', got '${raw}'`);
}

/** The POSIX/Windows-standard environment variable NAME shape. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names `CQ_RUN_ENV_PASSTHROUGH` may never copy into a run child (Annex B
 * §B.5): credential-shaped names the subprocess allowlist excludes by design.
 * `DATABASE_URL` and every other `*_URL` name are passable by NAME (`_URL` is
 * not a secret suffix); their VALUE must pass the URL acceptance rule
 * (`urlValueRefused`). Registry data: test/config/passthrough.test.ts checks it
 * against `DEFAULT_CHILD_ENV_ALLOWLIST` and the vendor names the registry
 * lists. Secret-suffixed names (`isSecretEnvName`), the `AWS_*` family and every
 * `CQ_*` name (a nested cq could read trust config from one) are refused on top
 * of this set.
 */
export const PASSTHROUGH_DENIED_NAMES: readonly string[] = Object.freeze([
  'NPM_TOKEN',
  'SSH_AUTH_SOCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NODE_OPTIONS',
  'NODE_PATH',
]);

/**
 * The names a TRUSTED (in-process, code-level) env allowlist may carry despite
 * the credential refusal. Every other refusal still applies to that origin
 * (credential-shaped names, every `CQ_*` name, the policy knobs). Frozen and
 * explicit: adding a name needs a stated reason in ADR-0009 ("Origin of env
 * names") and a change to test/harness/env-origin.test.ts, which pins this list.
 */
export const TRUSTED_ENV_EXEMPT_NAMES: readonly string[] = Object.freeze(['SSH_AUTH_SOCK']);

/**
 * The names a harness MANIFEST FILE's `envNames` may carry despite the
 * credential and `CQ_*` refusals. Empty: no current non-test caller needs one
 * (CQ_TEST_KEEP was only a test canary). Frozen; pinned by
 * test/harness/env-origin.test.ts; a name needs a stated reason in ADR-0009.
 */
export const DECLARED_ENV_EXEMPT_NAMES: readonly string[] = Object.freeze([]);

/**
 * Refuse a passthrough VALUE that carries URL credentials. A `*_URL` name is
 * allowed by name (`_URL` is not a secret suffix), but a value with userinfo
 * (`user@host`, `user:pass@host`) is refused, failing closed when it does not
 * parse. Applies to a URL-named variable and to any value with a scheme
 * separator. The message names the VARIABLE only, never the value. Returns the
 * reason text, or `undefined` when the value is fine.
 */
export function urlValueRefusal(name: string, value: string): string | undefined {
  return urlValueRefused(name, value)
    ? `value of '${name}' is not an acceptable URL (credentials, whitespace, backslash or unparseable); refused`
    : undefined;
}

/** True when `name` has the env var NAME shape. */
export function isEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

/**
 * Why a well-formed `name` is credential-shaped and may never reach a run
 * child from ANY origin (operator passthrough or harness manifest), or
 * `undefined`. Secret-suffixed names (which include every `*_URL`), the
 * `AWS_*` family and the listed names. Names the NAME only.
 */
export function credentialRefusal(name: string): string | undefined {
  const folded = name.toUpperCase();
  if (
    isSecretEnvName(name) ||
    folded.startsWith('AWS_') ||
    PASSTHROUGH_DENIED_NAMES.includes(folded)
  ) {
    return `may not expose credential-shaped name '${name}'`;
  }
  return undefined;
}

/**
 * Why a well-formed `name` may not be passed through by the OPERATOR key
 * (`CQ_RUN_ENV_PASSTHROUGH`): the credential refusal plus the sandbox policy
 * knobs and every `CQ_*` name. A malformed token is the caller's to report
 * (by position, never by text). Names the NAME only; a value never reaches here.
 */
export function passthroughRefusal(name: string): string | undefined {
  const folded = name.toUpperCase();
  if (SANDBOX_POLICY_ENV_NAMES.has(folded)) return `may not expose policy env '${name}'`;
  if (folded.startsWith('CQ_')) return `may not expose CQ_* name '${name}'`;
  return credentialRefusal(name);
}

/**
 * The ONE grammar and deny check for `CQ_RUN_ENV_PASSTHROUGH`: names separated
 * by commas and/or whitespace; blank means none. Every path (registry
 * snapshot, sandbox config, child-env builder, launcher) goes through here, so
 * a value is accepted or refused identically everywhere. Throws a config error
 * naming the first offending name (or, for a malformed token, its position).
 */
export function parsePassthrough(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const names = raw.split(/[,\s]+/).filter((name) => name !== '');
  names.forEach((name, index) => {
    // A malformed token may be an operator's `NAME=value` slip: report its
    // position only, never any part of the raw text.
    if (!isEnvName(name)) {
      throw new Error(
        `sandbox: CQ_RUN_ENV_PASSTHROUGH entry ${index + 1} is not an env var name (names match ${String(ENV_NAME_PATTERN)})`,
      );
    }
    const refusal = passthroughRefusal(name);
    if (refusal !== undefined) throw new Error(`sandbox: CQ_RUN_ENV_PASSTHROUGH ${refusal}`);
  });
  return [...new Set(names)];
}

/** A `provider/model` spec (structurally the driver layer's ModelSpec). */
export interface ParsedModelSpec {
  provider: string;
  model: string;
}

/**
 * Parse a `provider/model` spec. Exactly one slash, both halves non-empty,
 * no whitespace: a malformed value THROWS with the offending env name so a
 * typo fails the run loud instead of silently dispatching the default model.
 */
export function parseModelSpec(value: string, source: string): ParsedModelSpec {
  const parts = value.split('/');
  const provider = parts[0];
  const model = parts[1];
  if (
    parts.length !== 2 ||
    provider === undefined ||
    model === undefined ||
    provider === '' ||
    model === '' ||
    /\s/.test(value)
  ) {
    throw new Error(
      `selfhost: ${source} must be '<provider>/<model>' (got ${JSON.stringify(value)})`,
    );
  }
  return { provider, model };
}
