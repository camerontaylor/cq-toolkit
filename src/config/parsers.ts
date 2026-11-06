// Value parsers for the env registry. They live in src/config (below sandbox,
// selfhost, ops and driver) so the registry imports nothing from those layers
// and a later value-import of readCqEnv by sandbox/selfhost cannot form a cycle.
// The original modules re-export these, so existing callers are unchanged.

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

const ENV_NAMES = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function parsePassthrough(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    if (!ENV_NAMES.test(name)) {
      throw new Error(`sandbox: CQ_RUN_ENV_PASSTHROUGH contains invalid env name '${name}'`);
    }
    if (SANDBOX_POLICY_ENV_NAMES.has(name.toUpperCase())) {
      throw new Error(`sandbox: CQ_RUN_ENV_PASSTHROUGH may not expose policy env '${name}'`);
    }
  }
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
