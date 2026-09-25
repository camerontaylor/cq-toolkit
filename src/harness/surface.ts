// The shared harness tool-surface core — W1.4 (RS-12 design, ADR-0002
// Annex A.1). Transport-neutral and VENDOR-FREE: both driver lanes serve
// exactly this core, and only the transport differs —
//   - claude-agent adapts `surface.tools` onto the Agent SDK's in-process
//     `createSdkMcpServer` + `tool()` (handler = `surface.call`);
//   - subprocess serves the same surface over stdio through the
//     `cq-harness-mcp` server (src/harness/mcp/), which the `claude` CLI
//     launches from a per-run MCP config.
// So selection, binding, validation, execution, result mapping and naming
// are ONE implementation; the two-level parity test pins it.
//
// WHAT LIVES HERE:
//   - NAMING. The server is `cq-harness`; a tool's addressable spelling is
//     `mcp__cq-harness__<name>`. The server name has no `__` and the tool
//     names are lowercase ASCII, so the triple is unambiguous. Matching in
//     the CLI is byte-exact and case-sensitive over the whole triple
//     (RS-1b b3) — never respell these.
//   - SELECTION. `selectToolNames` is the frozen ToolPolicy intersection:
//     'none' → nothing; 'unrestricted' → every enabled harness tool;
//     'allowlist' (the default reading) → harness ∩ `allow`.
//   - BINDING. A strict plain-data MANIFEST authored by the DRIVER only
//     (`buildManifest`): the realpath of the resolved workspace, the sandbox
//     level, the selected tools, `DriverRequest.harness` (never plan JSON)
//     and the env NAMES `run` children may inherit. It adds no
//     OpInvocation field. An empty selection yields NO manifest — neither
//     lane registers a server then.
//   - EXECUTION. `createHarnessSurface(manifest)` is `buildTools` filtered
//     to `manifest.tools`, and THROWS unless the two agree exactly — the
//     driver's selection and the served surface cannot silently diverge.
//     Calls are SERIALIZED per surface (concurrent edit/run over one
//     workspace would race; the harness has no file locking). Each call
//     returns the MCP `CallToolResult` together with the harness outcome.
//   - CLASSIFICATION. `isHarnessDenial(text)` recognizes the stable harness
//     denial prefixes (tools.ts header) — the subprocess fold uses it to
//     tell a harness refusal from a transport failure.
//   - THE INIT-SURFACE COMPARATOR. `compareInitSurface` checks a reported
//     init surface (servers + tools) against the expected one, exactly —
//     a missing/failed harness, an extra server, or an unstripped builtin
//     is a mismatch.
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SandboxLevel, ToolPolicy } from '../driver/types.js';
import { stripMetaSchema } from '../driver/json-schema.js';
import { HarnessConfigSchema } from './config.js';
import type { HarnessConfig } from './config.js';
import { buildTools } from './tools.js';
import type { ToolkitTool, ToolkitToolName, ToolkitToolResult } from './tools.js';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** The MCP server name both lanes register the harness surface under. */
export const HARNESS_MCP_SERVER_NAME = 'cq-harness';

/** The addressable prefix of every harness tool (`mcp__<server>__`). */
const QUALIFIED_PREFIX = `mcp__${HARNESS_MCP_SERVER_NAME}__`;

/** A harness tool name → its addressable spelling `mcp__cq-harness__<name>`. */
export function qualifiedToolName(name: string): string {
  return `${QUALIFIED_PREFIX}${name}`;
}

/** An addressable spelling → the harness name (prefix stripped; foreign names verbatim). */
export function harnessToolName(qualified: string): string {
  return qualified.startsWith(QUALIFIED_PREFIX)
    ? qualified.slice(QUALIFIED_PREFIX.length)
    : qualified;
}

/** True when `name` is an addressable harness tool spelling. */
export function isQualifiedHarnessTool(name: string): boolean {
  return name.startsWith(QUALIFIED_PREFIX);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Frozen ToolPolicy → the allowed subset of `toolNames`: 'none' → nothing;
 * 'unrestricted' → all of them; 'allowlist' (the default reading when mode
 * is omitted) → the names in `allow` only. Order follows `toolNames`.
 */
export function selectToolNames<N extends string>(
  toolNames: readonly N[],
  policy: ToolPolicy,
): N[] {
  const mode = policy.mode ?? 'allowlist';
  if (mode === 'none') return [];
  if (mode === 'unrestricted') return [...toolNames];
  const allowed = new Set(policy.allow);
  return toolNames.filter((name) => allowed.has(name));
}

/**
 * The selected harness surface: the names `buildTools` produces for this
 * config (enabled tools, sliced to `promptBudget.maxTools`) ∩ the policy.
 * Throws on a config `buildTools` rejects (a corrupt allowlist is loud).
 */
export function selectHarnessSurface(
  harness: HarnessConfig,
  toolPolicy: ToolPolicy,
): ToolkitToolName[] {
  // buildTools touches no filesystem at build time; the workspace argument
  // only anchors the (lazy) executors, which are discarded here.
  const names = buildTools(harness, resolve('.'), 'none').map((tool) => tool.name);
  return selectToolNames(names, toolPolicy);
}

// ---------------------------------------------------------------------------
// Binding — the manifest
// ---------------------------------------------------------------------------

/** The env-var NAME shape (POSIX/Windows standard) — names only, never values. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The whole binding of one harness surface, as strict plain data (Annex
 * A.1). Unknown keys fail; `tools` is non-empty and duplicate-free.
 */
export const HarnessManifestSchema = z
  .object({
    v: z.literal(1),
    /** realpath of the bound workspace; absolute; an existing directory. */
    workspace: z.string().min(1),
    sandbox: z.enum(['none', 'workspace-write', 'read-only']),
    /** The selected surface (harness ∩ ToolPolicy), already intersected. */
    tools: z
      .array(z.enum(['read', 'edit', 'run']))
      .min(1)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: 'tools must not repeat a name',
      }),
    /** DriverRequest.harness (factory config) or the lane default — never plan JSON. */
    harness: HarnessConfigSchema,
    /** Extra env NAMES `run` children may inherit on top of the default allowlist. */
    envNames: z.array(z.string().regex(ENV_NAME)).default([]),
  })
  .strict();

export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

/** Inputs to `buildManifest` — everything the driver resolved, plain data. */
export interface ManifestInputs {
  /** The workspace the driver resolved (ADR-0002 §2.4); realpathed here. */
  workspace: string;
  sandbox: SandboxLevel;
  toolPolicy: ToolPolicy;
  /** DriverRequest.harness, else the lane default. */
  harness: HarnessConfig;
  /** The lane's deployment env allowlist (names only). Default []. */
  envNames?: readonly string[] | undefined;
}

/**
 * THE ONLY MANIFEST CONSTRUCTOR in the driver family. Realpaths the
 * workspace (it must be an existing directory), selects the surface, and
 * returns the strictly-parsed manifest — or `undefined` when the selection
 * is empty (no server is registered then). Throws on a missing workspace,
 * a non-directory, or a config/env-name the schema rejects: all
 * pre-dispatch failures.
 */
export async function buildManifest(inputs: ManifestInputs): Promise<HarnessManifest | undefined> {
  const tools = selectHarnessSurface(inputs.harness, inputs.toolPolicy);
  if (tools.length === 0) return undefined;
  const workspace = await realpath(inputs.workspace);
  if (!(await stat(workspace)).isDirectory()) {
    throw new Error(`harness manifest: workspace '${workspace}' is not a directory`);
  }
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: inputs.sandbox,
    tools,
    harness: inputs.harness,
    // Preserve deployment opt-in names across both transports. The stdio
    // startup scrub consumes CQ_RUN_ENV_PASSTHROUGH itself; retaining names
    // in the manifest lets the shared run core perform its own scrub too.
    // Strict manifest validation below accepts names only, never values.
    envNames: [
      ...new Set([
        ...(inputs.envNames ?? []),
        ...(process.env['CQ_RUN_ENV_PASSTHROUGH'] ?? '').split(/[,\s]+/).filter(Boolean),
      ]),
    ],
  });
}

// ---------------------------------------------------------------------------
// Execution — the surface
// ---------------------------------------------------------------------------

/** The MCP `CallToolResult` subset the harness produces — identical on both transports. */
export interface McpCallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

/** One served tool: its descriptor plus the strict JSON Schema `tools/list` advertises. */
export interface HarnessSurfaceTool {
  name: ToolkitToolName;
  description: string;
  /** The harness zod input schema (strict). */
  inputSchema: ToolkitTool['inputSchema'];
  /** `z.toJSONSchema` of the strict input schema, meta-schema stripped (`additionalProperties: false`). */
  inputJsonSchema: Record<string, unknown>;
}

/** One call's outcome: the wire result and the harness outcome it was mapped from. */
export interface HarnessCallOutcome {
  result: McpCallToolResult;
  outcome: ToolkitToolResult;
}

/** A bound, serialized harness surface. */
export interface HarnessSurface {
  readonly manifest: HarnessManifest;
  /** The served tools, in `manifest.tools` order. */
  readonly tools: readonly HarnessSurfaceTool[];
  /** True when `name` is a served tool. */
  has(name: string): name is ToolkitToolName;
  /**
   * Execute one served tool. Calls run one at a time, in arrival order.
   * Throws only for an unserved name (a caller bug — transports check
   * `has` first); every harness refusal is a denial outcome.
   */
  call(
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<HarnessCallOutcome>;
}

/** Harness outcome → the MCP CallToolResult (the exact mapping both transports return). */
export function toCallToolResult(outcome: ToolkitToolResult): McpCallToolResult {
  return outcome.ok
    ? { content: [{ type: 'text', text: outcome.output }] }
    : { content: [{ type: 'text', text: outcome.denial.reason }], isError: true };
}

/**
 * Bind a manifest to executors. Re-validates the manifest strictly, builds
 * the harness tools for its workspace/sandbox/config, and filters them to
 * `manifest.tools` — THROWING unless every named tool exists (a disabled
 * tool or a `maxTools` slice that dropped one is a divergence, never a
 * silently smaller surface).
 */
export function createHarnessSurface(input: HarnessManifest): HarnessSurface {
  const manifest = HarnessManifestSchema.parse(input);
  const built = buildTools(
    manifest.harness,
    manifest.workspace,
    manifest.sandbox,
    manifest.envNames,
  );
  const byName = new Map(built.map((tool) => [tool.name, tool] as const));
  const missing = manifest.tools.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `harness surface: manifest names tools the harness config does not provide: ${missing.join(', ')}`,
    );
  }
  const served = manifest.tools.map((name) => byName.get(name) as ToolkitTool);
  const tools: HarnessSurfaceTool[] = served.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    inputJsonSchema: stripMetaSchema(z.toJSONSchema(tool.inputSchema)) as Record<string, unknown>,
  }));
  const servedNames = new Set<string>(manifest.tools);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    manifest,
    tools,
    has(name: string): name is ToolkitToolName {
      return servedNames.has(name);
    },
    call(name, args, opts) {
      const tool = byName.get(name as ToolkitToolName);
      if (tool === undefined || !servedNames.has(name)) {
        return Promise.reject(new Error(`harness surface: '${name}' is not a served tool`));
      }
      const run = queue.then(async (): Promise<HarnessCallOutcome> => {
        // A call cancelled while it waited in the queue never executes (an
        // `edit` must not write after its cancellation or a governed abort).
        const outcome: ToolkitToolResult =
          opts?.signal?.aborted === true
            ? {
                ok: false,
                denial: {
                  tool: tool.name,
                  reason: 'cancelled: the call was cancelled before it ran',
                },
              }
            : await tool.execute(args, opts);
        return { result: toCallToolResult(outcome), outcome };
      });
      // Serialize: the next call waits for this one to settle either way.
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// Classification — stable harness denial prefixes
// ---------------------------------------------------------------------------

/**
 * The stable denial-reason prefixes every harness refusal starts with
 * (tools.ts header; the conformance suite asserts on them). Frozen.
 */
export const HARNESS_DENIAL_PREFIXES: readonly string[] = Object.freeze([
  'sandbox: ',
  'invalid input: ',
  'path escape: ',
  'path not allowed by harness config allowlist: ',
  'command not allowed by harness config allowlist: ',
  'command allowlist: ',
  'file not found: ',
  'read failed: ',
  'edit refused: ',
  'edit failed: ',
  'run failed: ',
  'cancelled: ',
]);

/** True only for text that starts with a stable harness denial prefix. */
export function isHarnessDenial(text: string): boolean {
  return HARNESS_DENIAL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// The init-surface comparator
// ---------------------------------------------------------------------------

/** The `{name, status}` projection of one reported MCP server. */
export interface ServerStatus {
  name: string;
  status: string;
}

/** What an init report must show, exactly. */
export interface ExpectedInitSurface {
  /** Whether the harness server was configured (non-empty selection). */
  harness: boolean;
  /** Harness tool names selected (qualified by the comparator). */
  tools: readonly string[];
  /** Host-internal tools always present in this mode (pinned by the live leg, e.g. `StructuredOutput`). */
  internalTools?: readonly string[];
}

/** The comparator verdict: ok, or the expected/observed pair for the narration. */
export type InitSurfaceVerdict =
  | { ok: true }
  | {
      ok: false;
      expected: { mcp_servers: ServerStatus[]; tools: string[] };
      observed: { mcp_servers: ServerStatus[] | unknown; tools: string[] | unknown };
    };

/**
 * Compare a reported init surface against the expected one, EXACTLY:
 *   - servers, on the `{name, status}` projection (entries carry extra
 *     fields such as `source`): exactly `cq-harness`/`connected` when the
 *     harness was configured, else none;
 *   - tools, as a set: exactly the qualified selected names plus the pinned
 *     host-internal tools.
 * Anything unshaped is a mismatch — fail closed.
 */
export function compareInitSurface(
  expected: ExpectedInitSurface,
  observed: { mcp_servers: unknown; tools: unknown },
): InitSurfaceVerdict {
  const expectedServers: ServerStatus[] = expected.harness
    ? [{ name: HARNESS_MCP_SERVER_NAME, status: 'connected' }]
    : [];
  const expectedTools = [
    ...expected.tools.map(qualifiedToolName),
    ...(expected.internalTools ?? []),
  ].sort();
  const servers = projectServers(observed.mcp_servers);
  const tools = stringArray(observed.tools);
  const serversOk =
    servers !== undefined &&
    servers.length === expectedServers.length &&
    servers.every(
      (server, i) =>
        server.name === expectedServers[i]?.name && server.status === expectedServers[i]?.status,
    );
  const sortedTools = tools === undefined ? undefined : [...tools].sort();
  const toolsOk =
    sortedTools !== undefined &&
    sortedTools.length === expectedTools.length &&
    sortedTools.every((tool, i) => tool === expectedTools[i]);
  if (serversOk && toolsOk) return { ok: true };
  return {
    ok: false,
    expected: { mcp_servers: expectedServers, tools: expectedTools },
    observed: {
      mcp_servers: servers ?? observed.mcp_servers,
      tools: sortedTools ?? observed.tools,
    },
  };
}

/** `mcp_servers` → its `{name, status}` projection (sorted by name), or undefined when unshaped. */
function projectServers(raw: unknown): ServerStatus[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ServerStatus[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const rec = entry as Record<string, unknown>;
    if (typeof rec['name'] !== 'string' || typeof rec['status'] !== 'string') return undefined;
    out.push({ name: rec['name'], status: rec['status'] });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** An array of strings, or undefined when unshaped. */
function stringArray(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')
    ? (raw as string[])
    : undefined;
}
