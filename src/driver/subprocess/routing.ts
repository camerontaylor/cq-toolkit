// Env-based model routing for the subprocess driver — T1.5 slice 1.
//
// ROUTING IS CONFIG, NOT CODE. Which endpoint a model rides, which env vars
// carry its base URL and API key, and which model names the endpoint is
// KNOWN to accept are all plain serializable data (`RoutingTable`) — the
// subprocess driver never hardcodes endpoint knowledge into its control
// flow. `defaultRoutingTable()` is the documented DEFAULT VALUE of that
// data (provider docs, as-of 2026-09); a deployment overrides it wholesale
// via the driver's `routingTable` option, the same R4 posture as the
// harness config (src/harness/config.ts).
//
// THE ANTHROPIC-COMPAT PATTERN: every endpoint in the default table speaks
// the Anthropic Messages API on the wire, which is what lets ONE headless
// CLI binary (the Claude-Code-style agent, default `claude`) serve all of
// them — the driver points the CLI at an endpoint purely through env
// injection (`ANTHROPIC_BASE_URL` for the endpoint, an auth-token var for
// the key). This env-based routing is provider-documented for Z.AI
// (https://docs.z.ai/devpack/tool/claude) and DeepSeek
// (https://api-docs.deepseek.com/guides/anthropic_api); the native
// `anthropic` endpoint is the CLI's own default. Values are CONFIG
// as-of 2026-09: re-verify against the provider pages on any model change.
//
// THE DEEPSEEK SILENT-REMAP FOOTGUN (asserted loudly, before any spawn):
// an anthropic-compat gateway does not validate the model name you send —
// DeepSeek-style endpoints accept ANY model string and SILENTLY SERVE THEIR
// DEFAULT MODEL instead (a typo'd 'deepseek-chat-v2' still bills you, it
// just bills you for a model you did not ask for). A silent remap poisons
// every downstream fact (pricing attribution, capability assumptions,
// eval comparability), so `routeFor` REFUSES to route a model name that is
// not on the endpoint's allowlist: the error names the footgun and the run
// never dispatches. Fail loudly, never guess — the same posture as the
// ai-sdk driver's unknown-provider throw.
//
// SECRETS STAY NAME-ONLY: a `Route` carries WHICH env var holds the key
// (`env: { CHILD_VAR: HOST_VAR_NAME }`), never the value. Routes are plain
// serializable data — safe to log, journal, or ship in an error message.
// The driver reads the actual values from the environment at run() time
// and throws a clear pre-dispatch error when one is missing.
import { z } from 'zod';
import type { ModelSpec } from '../types.js';

// ---------------------------------------------------------------------------
// The routing table — plain data, schema-validated (invalid tables throw loudly)
// ---------------------------------------------------------------------------

/**
 * One endpoint entry: which host env var overrides its base URL
 * (`baseUrlEnv`), the provider-documented default URL when that var is
 * unset (`baseUrlDefault`), which env var holds its API key (`keyEnv`),
 * the model names the endpoint is KNOWN to serve (`models` — the allowlist
 * the footgun rule enforces), and human notes (`notes`).
 */
export const RoutingEndpointSchema = z.object({
  baseUrlEnv: z.string().min(1),
  baseUrlDefault: z.string().min(1),
  keyEnv: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  notes: z.string().min(1),
}).strict();

/**
 * The whole table: endpoint name (the frozen ModelSpec.provider handle) →
 * entry. Plain serializable data.
 */
export const RoutingTableSchema = z.object({
  endpoints: z.record(z.string(), RoutingEndpointSchema),
}).strict();

export type RoutingEndpoint = z.infer<typeof RoutingEndpointSchema>;
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

/**
 * The documented default routing table — CONFIG as-of 2026-09, transcribed
 * from the providers' anthropic-compat docs (see header). Treat as
 * immutable: `routeFor` re-validates whatever table it is handed, but
 * callers should not mutate the exported value. Model allowlists align
 * with the vendored price table (src/driver/pricing/data.ts) plus the
 * other current documented names.
 */
export function defaultRoutingTable(): RoutingTable {
  return RoutingTableSchema.parse({
    endpoints: {
      // https://docs.z.ai/devpack/tool/claude — the Z.AI anthropic-compat
      // endpoint for Claude-Code-style CLIs; GLM family model names.
      zai: {
        baseUrlEnv: 'ZAI_ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.z.ai/api/anthropic',
        keyEnv: 'ZAI_API_KEY',
        models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4.5v'],
        notes:
          'Z.AI anthropic-compat endpoint (docs as-of 2026-09). Base URL overridable via ' +
          'ZAI_ANTHROPIC_BASE_URL; API key read from ZAI_API_KEY at dispatch time.',
      },
      // https://api-docs.deepseek.com/guides/anthropic_api — the DeepSeek
      // anthropic-compat endpoint; THE namesake of the silent-remap footgun.
      deepseek: {
        baseUrlEnv: 'DEEPSEEK_ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.deepseek.com/anthropic',
        keyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        notes:
          'DeepSeek anthropic-compat endpoint (docs as-of 2026-09). Unknown model names are ' +
          'silently remapped to the endpoint default — the footgun routeFor refuses to dispatch on.',
      },
      // The CLI's native endpoint — no compat layer.
      anthropic: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.anthropic.com',
        keyEnv: 'ANTHROPIC_API_KEY',
        models: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'],
        notes:
          'Native Anthropic endpoint (docs as-of 2026-09); base URL overridable via the CLI\'s own ' +
          'ANTHROPIC_BASE_URL convention. Names align with the vendored price table.',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Route — the resolved, serializable, secret-free dispatch plan
// ---------------------------------------------------------------------------

/**
 * One resolved dispatch route (plain data): the endpoint name, the resolved
 * base URL (host env override wins over the documented default), the child
 * env injection plan, and the (allowlist-verified) model id.
 *
 * `env` is NAME-ONLY: each entry maps a child env var name to the NAME of
 * the host env var whose value it takes — never the value itself, so a
 * Route can be logged or journaled without leaking secrets. The driver
 * resolves the values from the environment at run() time and throws a
 * clear pre-dispatch error when a named var is missing.
 */
export interface Route {
  /** The routing-table endpoint this model resolved to. */
  endpoint: string;
  /** Base URL the CLI child will be pointed at (env override, else default). */
  baseUrl: string;
  /** Auth injection plan: child env var name → HOST env var NAME (name-only). */
  env: Readonly<Record<string, string>>;
  /** The model id, verified against the endpoint allowlist. */
  model: string;
}

/**
 * The child env vars every routed CLI run receives for the auth plan. Both
 * spellings are set from the same host var because anthropic-compat
 * consumers differ on which they read (the native CLI reads
 * ANTHROPIC_AUTH_TOKEN for gateway tokens; some tooling reads
 * ANTHROPIC_API_KEY). The endpoint base URL itself is injected by the
 * driver from `Route.baseUrl` (a resolved VALUE, not a name).
 */
function authEnvPlan(keyEnv: string): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: keyEnv,
    ANTHROPIC_API_KEY: keyEnv,
  };
}

/**
 * Resolve a frozen ModelSpec onto a concrete Route. THROWS before dispatch:
 *   - an unknown provider (no such endpoint in the table);
 *   - a model not on the endpoint's allowlist — THE FOOTGUN RULE (header);
 *   - a table that fails `RoutingTableSchema` (corrupt config is loud).
 *
 * `env` is the environment the base URL is resolved against (defaults to
 * `process.env`; tests inject a literal record). A set-but-EMPTY override
 * counts as unset — the documented default applies.
 */
export function routeFor(
  modelSpec: ModelSpec,
  table: RoutingTable = defaultRoutingTable(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Route {
  const parsed: RoutingTable = RoutingTableSchema.parse(table);
  const endpointName = modelSpec.provider;
  const endpoint = parsed.endpoints[endpointName];
  if (endpoint === undefined) {
    throw new Error(
      `routing: unknown provider '${endpointName}' (known endpoints: ${Object.keys(parsed.endpoints).join(', ')})`,
    );
  }
  if (!endpoint.models.includes(modelSpec.model)) {
    throw new Error(
      `routing: model '${modelSpec.model}' is not on the ${endpointName} allowlist — ` +
        'DeepSeek-style endpoints silently remap unknown model names; refusing to dispatch',
    );
  }
  const override = env[endpoint.baseUrlEnv];
  const baseUrl =
    override !== undefined && override !== '' ? override : endpoint.baseUrlDefault;
  return {
    endpoint: endpointName,
    baseUrl,
    env: authEnvPlan(endpoint.keyEnv),
    model: modelSpec.model,
  };
}
