// Endpoint routing for the Claude Code lane — Phase 1.9 (the ONE table both
// transports share; consolidates the former subprocess lane's routing.ts and
// the former claude-agent lane's routing.ts, whose shipped defaults this
// module reproduces byte-for-byte on the three live fields).
//
// ROUTING IS CONFIG, NOT CODE. Which endpoint a model rides, which env vars
// carry its base URL and API key, and which model names the endpoint is
// KNOWN to accept are all plain serializable data (`RoutingTable`) — the
// lane never hardcodes endpoint knowledge into its control flow.
// `defaultRoutingTable()` is the documented DEFAULT VALUE of that data
// (provider docs, as-of 2026-09); a deployment overrides it wholesale via
// the driver's `routingTable` option, the same R4 posture as the harness
// config (src/harness/config.ts).
//
// THE ANTHROPIC-COMPAT PATTERN: every endpoint in the default table speaks
// the Anthropic Messages API on the wire, which is what lets ONE substrate
// (the `claude` CLI headless, or the agent SDK that drives the same CLI)
// serve all of them — the lane points the substrate at an endpoint purely
// through env injection (`ANTHROPIC_BASE_URL` for the endpoint, an
// auth-token var for the key). This env-based routing is provider-documented
// for Z.AI (https://docs.z.ai/devpack/tool/claude) and DeepSeek
// (https://api-docs.deepseek.com/guides/anthropic_api); the native
// `anthropic` endpoint is the CLI's own default. Values are CONFIG
// as-of 2026-09: re-verify against the provider pages on any model change.
//
// THE NO-ALLOWLIST RULE (owner override 2026-09-14; ADR-0002 §2.6
// retirement): the model-allowlist check is RETIRED — any model id routes
// UNCHECKED to the endpoint the provider handle names. The historical
// per-endpoint `models` rows are still ACCEPTED table data (plan configs
// and shipped tables carry them) but are NO LONGER ENFORCED, and the
// shipped default table no longer carries them. The silent-remap defence
// moved to the RESPONSE side, where the fact is observable: the lane
// surfaces the model id the substrate reports as served into
// `WorkerResult.model` (the observed, never the requested id), and the
// shared served-model assertion (src/driver/served-model.ts, applied to
// every factory-resolved driver) rewrites a mismatching completed run to
// error / 'served-model-mismatch'. What still throws here BEFORE dispatch
// is an unknown PROVIDER — routing to a provider the deployment has no
// endpoint config for is a configuration error, not a model outcome.
//
// SECRETS STAY NAME-ONLY: a resolved route carries WHICH env var holds the
// key (`keyEnv`), never the value. Tables are plain serializable data —
// safe to log, journal, or ship in an error message. The lane reads the
// actual values from the environment at run() time and throws a clear
// pre-dispatch error when one is missing.
import { z } from 'zod';
import { DispatchError } from '../errors.js';
import type { ModelSpec } from '../types.js';

// ---------------------------------------------------------------------------
// The routing table — plain data, schema-validated (invalid tables throw loudly)
// ---------------------------------------------------------------------------

/**
 * One endpoint entry: which host env var overrides its base URL
 * (`baseUrlEnv`), the provider-documented default URL when that var is
 * unset (`baseUrlDefault`), which env var holds its API key (`keyEnv`),
 * and human notes (`notes`). The historical `models` allowlist field is
 * still ACCEPTED table data (plan configs carry it) but is NO LONGER
 * ENFORCED — the model-allowlist check is retired (ADR-0002 §2.6, owner
 * override 2026-09-14); the post-dispatch served-model assertion is the
 * defence.
 */
export const RoutingEndpointSchema = z
  .object({
    baseUrlEnv: z.string().min(1),
    baseUrlDefault: z.string().min(1),
    keyEnv: z.string().min(1),
    models: z.array(z.string().min(1)).min(1).optional(),
    notes: z.string().min(1),
  })
  .strict();

/**
 * The whole table: endpoint name (the frozen ModelSpec.provider handle) →
 * entry. Plain serializable data.
 */
export const RoutingTableSchema = z
  .object({
    endpoints: z.record(z.string(), RoutingEndpointSchema),
  })
  .strict();

export type RoutingEndpoint = z.infer<typeof RoutingEndpointSchema>;
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

/**
 * The documented default routing table — CONFIG as-of 2026-09, transcribed
 * from the providers' anthropic-compat docs (see header). Treat as
 * immutable: `resolveRoute` re-validates whatever table it is handed, but
 * callers should not mutate the exported value. No `models` rows: the
 * allowlist is retired, so the shipped default carries none (a deployment
 * table that still has them validates and stays unenforced).
 */
export function defaultRoutingTable(): RoutingTable {
  return RoutingTableSchema.parse({
    endpoints: {
      // https://docs.z.ai/devpack/tool/claude — the Z.AI anthropic-compat
      // endpoint for Claude-Code-style substrates; any GLM-family model id
      // rides through unchecked.
      zai: {
        baseUrlEnv: 'ZAI_ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.z.ai/api/anthropic',
        keyEnv: 'ZAI_API_KEY',
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
        notes:
          'DeepSeek anthropic-compat endpoint (docs as-of 2026-09). Unknown model names are ' +
          'silently remapped to the endpoint default — the served-model assertion (ADR-0002 ' +
          '§2.6) fails the remap post-hoc; WorkerResult.model carries the observed id.',
      },
      // The substrate's native endpoint — no compat layer.
      anthropic: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.anthropic.com',
        keyEnv: 'ANTHROPIC_API_KEY',
        notes:
          "Native Anthropic endpoint (docs as-of 2026-09); base URL overridable via the CLI's own " +
          'ANTHROPIC_BASE_URL convention.',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Route — the resolved, serializable, secret-free dispatch plan
// ---------------------------------------------------------------------------

/**
 * One resolved dispatch route (plain data, secret-free): the endpoint name,
 * the resolved base URL (host env override wins over the documented
 * default), the NAME of the host env var holding the API key, and the model
 * id routed verbatim (no name check — the allowlist is retired; the
 * observed served id is the fact the post-dispatch assertion judges).
 *
 * The key VALUE is resolved by the transport from the environment at run()
 * time — a missing one throws pre-dispatch (the never-guess posture, both
 * transports). The CLI transport maps `keyEnv` onto the substrate's auth
 * vars (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`); the SDK transport reads
 * the value and injects the same spellings through its `env` option.
 */
export interface Route {
  /** The routing-table endpoint this model resolved to. */
  endpoint: string;
  /** Base URL the substrate is pointed at (env override, else default). */
  baseUrl: string;
  /** NAME of the host env var holding the API key — never the value. */
  keyEnv: string;
  /** The model id, routed verbatim (the allowlist check is retired). */
  model: string;
}

/**
 * The child env vars every routed substrate run receives for the auth plan.
 * Both spellings are set from the same host var because anthropic-compat
 * consumers differ on which they read (the native CLI reads
 * ANTHROPIC_AUTH_TOKEN for gateway tokens; some tooling reads
 * ANTHROPIC_API_KEY). The endpoint base URL itself is injected by the
 * transport from `Route.baseUrl` (a resolved VALUE, not a name).
 */
export function authEnvPlan(keyEnv: string): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: keyEnv,
    ANTHROPIC_API_KEY: keyEnv,
  };
}

/**
 * Resolve a frozen ModelSpec onto a concrete Route. THROWS before dispatch:
 *   - an unknown provider (no such endpoint in the table);
 *   - a table that fails `RoutingTableSchema` (corrupt config is loud).
 * The model id is NOT inspected — the model-allowlist check is RETIRED
 * (ADR-0002 §2.6, owner override 2026-09-14): any name routes, the endpoint
 * reports what it actually served, and the shared served-model assertion
 * fails a remap post-hoc.
 *
 * `env` is the environment the base URL is resolved against (defaults to
 * `process.env`; tests inject a literal record). A set-but-EMPTY override
 * counts as unset — the documented default applies.
 */
export function resolveRoute(
  modelSpec: ModelSpec,
  table: RoutingTable = defaultRoutingTable(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Route {
  const parsed: RoutingTable = RoutingTableSchema.parse(table);
  const endpointName = modelSpec.provider;
  // Own-property guard (carried from both consolidated lanes): the parsed
  // record inherits Object.prototype, so a provider handle like
  // 'constructor' or 'toString' would otherwise resolve to an inherited
  // value and DODGE the unknown-provider throw.
  const endpoint = Object.prototype.hasOwnProperty.call(parsed.endpoints, endpointName)
    ? parsed.endpoints[endpointName]
    : undefined;
  if (endpoint === undefined) {
    // Pre-dispatch misconfiguration carries its class as structured data
    // (ADR-0002 §2.2): errorClassOf → 'config'.
    throw new DispatchError(
      'config',
      `claude-code driver: unknown provider '${endpointName}' (known endpoints: ${Object.keys(parsed.endpoints).join(', ')})`,
    );
  }
  const override = env[endpoint.baseUrlEnv];
  const baseUrl = override !== undefined && override !== '' ? override : endpoint.baseUrlDefault;
  return { endpoint: endpointName, baseUrl, keyEnv: endpoint.keyEnv, model: modelSpec.model };
}
