// Endpoint routing for the claude-agent driver — T1.6.
//
// ROUTING IS CONFIG, NOT CODE — the same posture as the subprocess lane's
// routing.ts (src/driver/subprocess/routing.ts), narrowed to what THIS lane
// may decide. The agent SDK speaks the Anthropic Messages API on the wire
// and takes its endpoint + credential through the environment, which lets
// ONE SDK serve every anthropic-compat provider: the driver points the
// query at an endpoint purely through env injection (`ANTHROPIC_BASE_URL`
// for the endpoint, auth-token vars for the key — the SDK's `env` option
// replaces the subprocess environment wholesale, so the driver builds the
// child environment itself).
//
// THE NO-ALLOWLIST RULE (owner override 2026-09-14): unlike the subprocess
// table, an endpoint entry carries NO model list and `resolveEndpoint`
// performs NO model check — any model id is routed UNCHECKED to the
// endpoint the provider handle names. The silent-remap defence moved to the
// RESPONSE side: the driver surfaces the model id the agent reports as
// served into `WorkerResult.model` (the observed, never the requested id),
// and the shared conformance suite's observed-model check (leg m) fails a
// lane that remaps silently or cannot observe. Pre-dispatch allowlists and
// post-dispatch observation are alternative defences; this lane deliberately
// takes the second — see the driver header.
//
// WHAT STILL THROWS BEFORE DISPATCH (fail loudly, never guess):
//   - an unknown provider (no such endpoint in the table) — the same
//     posture as the ai-sdk driver's unknown-provider throw;
//   - a table that fails `EndpointTableSchema` (corrupt config is loud).
// The KEY VALUE is read from the environment at run() time (by the driver,
// never here); a missing one throws pre-dispatch. Entries carry var NAMES
// only, never secrets — a table is safe to log, journal, or ship in an
// error message.
import { z } from 'zod';
import type { ModelSpec } from '../types.js';

// ---------------------------------------------------------------------------
// The endpoint table — plain data, schema-validated (invalid tables throw loudly)
// ---------------------------------------------------------------------------

/**
 * One endpoint entry: which host env var overrides its base URL
 * (`baseUrlEnv`), the provider-documented default URL when that var is
 * unset (`baseUrlDefault`), which env var holds its API key (`keyEnv`), and
 * human notes (`notes`). Deliberately NO `models` field — see the header's
 * no-allowlist rule.
 */
export const EndpointEntrySchema = z
  .object({
    baseUrlEnv: z.string().min(1),
    baseUrlDefault: z.string().min(1),
    keyEnv: z.string().min(1),
    notes: z.string().min(1),
  })
  .strict();

/**
 * The whole table: endpoint name (the frozen ModelSpec.provider handle) →
 * entry. Plain serializable data.
 */
export const EndpointTableSchema = z
  .object({
    endpoints: z.record(z.string(), EndpointEntrySchema),
  })
  .strict();

export type EndpointEntry = z.infer<typeof EndpointEntrySchema>;
export type EndpointTable = z.infer<typeof EndpointTableSchema>;

/**
 * The documented default endpoint table — CONFIG as-of 2026-09, the same
 * provider endpoints the subprocess lane routes (values transcribed from
 * the providers' anthropic-compat docs: Z.AI
 * https://docs.z.ai/devpack/tool/claude, DeepSeek
 * https://api-docs.deepseek.com/guides/anthropic_api, and the native
 * Anthropic endpoint). Treat as immutable: `resolveEndpoint` re-validates
 * whatever table it is handed, but callers should not mutate the exported
 * value. A deployment overrides it wholesale via the driver's `endpointTable`
 * option — the same R4 posture as the harness config.
 */
export function defaultEndpointTable(): EndpointTable {
  return EndpointTableSchema.parse({
    endpoints: {
      // https://docs.z.ai/devpack/tool/claude — the Z.AI anthropic-compat
      // endpoint; any GLM-family model id rides through unchecked.
      zai: {
        baseUrlEnv: 'ZAI_ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.z.ai/api/anthropic',
        keyEnv: 'ZAI_API_KEY',
        notes:
          'Z.AI anthropic-compat endpoint (docs as-of 2026-09). Base URL overridable via ' +
          'ZAI_ANTHROPIC_BASE_URL; API key read from ZAI_API_KEY at dispatch time.',
      },
      // https://api-docs.deepseek.com/guides/anthropic_api — the DeepSeek
      // anthropic-compat endpoint. The silent-remap footgun is NOT defended
      // here by a name allowlist (owner override 2026-09-14): the observed-
      // model check is this lane's defence (header).
      deepseek: {
        baseUrlEnv: 'DEEPSEEK_ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.deepseek.com/anthropic',
        keyEnv: 'DEEPSEEK_API_KEY',
        notes:
          'DeepSeek anthropic-compat endpoint (docs as-of 2026-09). Unknown model names may be ' +
          'silently remapped by the endpoint — WorkerResult.model carries the observed id so the ' +
          'conformance suite can fail the remap.',
      },
      // The SDK's native endpoint — no compat layer.
      anthropic: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        baseUrlDefault: 'https://api.anthropic.com',
        keyEnv: 'ANTHROPIC_API_KEY',
        notes:
          "Native Anthropic endpoint (docs as-of 2026-09); base URL overridable via the SDK's own " +
          'ANTHROPIC_BASE_URL convention.',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Resolution — the endpoint only, never a model verdict
// ---------------------------------------------------------------------------

/**
 * One resolved dispatch endpoint (plain data, secret-free): the endpoint
 * name, the resolved base URL (host env override wins over the documented
 * default), and the NAME of the env var holding the API key. The key VALUE
 * is resolved by the driver from the environment at run() time — a missing
 * one throws pre-dispatch (the same never-guess posture as the subprocess
 * lane's auth check).
 */
export interface ResolvedEndpoint {
  /** The routing-table endpoint this provider handle resolved to. */
  endpoint: string;
  /** Base URL the agent is pointed at (env override, else default). */
  baseUrl: string;
  /** NAME of the host env var holding the API key — never the value. */
  keyEnv: string;
}

/**
 * Resolve a frozen ModelSpec's PROVIDER onto a concrete endpoint. THROWS
 * before dispatch on an unknown provider or a table that fails
 * `EndpointTableSchema`. The model id (`modelSpec.model`) is NOT inspected:
 * it rides through UNCHECKED to `Options.model` (owner override 2026-09-14,
 * header) — there is deliberately no routeFor-style model throw in this
 * lane.
 *
 * `env` is the environment the base URL is resolved against (defaults to
 * `process.env`; tests inject a literal record). A set-but-EMPTY override
 * counts as unset — the documented default applies.
 */
export function resolveEndpoint(
  modelSpec: ModelSpec,
  table: EndpointTable = defaultEndpointTable(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedEndpoint {
  const parsed: EndpointTable = EndpointTableSchema.parse(table);
  const endpointName = modelSpec.provider;
  // Own-property guard: the parsed record inherits Object.prototype, so a
  // provider handle like 'constructor' or 'toString' would otherwise
  // resolve to an inherited value and DODGE the unknown-provider throw.
  const entry = Object.prototype.hasOwnProperty.call(parsed.endpoints, endpointName)
    ? parsed.endpoints[endpointName]
    : undefined;
  if (entry === undefined) {
    throw new Error(
      `claude-agent driver: unknown provider '${endpointName}' (known endpoints: ${Object.keys(parsed.endpoints).join(', ')})`,
    );
  }
  const override = env[entry.baseUrlEnv];
  const baseUrl = override !== undefined && override !== '' ? override : entry.baseUrlDefault;
  return { endpoint: endpointName, baseUrl, keyEnv: entry.keyEnv };
}
