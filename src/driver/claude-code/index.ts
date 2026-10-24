// The Claude Code lane — Phase 1.9 (D-E′ option A: ONE cq-owned lane for
// the Claude Code substrate, merging the former `driver/subprocess` and
// `driver/claude-agent` lanes). CLI PRIMARY, Agent SDK OPTIONAL: the
// transport is CONFIGURATION (`transport: 'cli' | 'sdk'`, default 'cli') —
// never a src literal — and the SDK remains an optional peer dependency
// loaded lazily only when the 'sdk' transport is selected.
//
// WHAT THE MERGE SHARES (one implementation each):
//   - routing.ts — the ONE endpoint/routing table (plain serializable
//     CONFIG; model/provider choices are never src literals);
//   - shared/proc.ts — the canonical CLI process ladder and env scrub;
//     process.ts retains the I8-exempt SDK cancellation-root wiring;
//   - usage.ts — the ONE worker-accounting fold: per-model token
//     aggregates (modelUsage — subagent spend included) preferred over the
//     flat main-loop usage over the assistant fallback, fold PROVENANCE
//     markers, unknown-versus-zero honesty, version-gated resumed-usage
//     semantics, and the ONE derived-only cost field;
//   - failures.ts — the ONE error-class classifier (vendor limit texts,
//     reset/retry parsers, cut order);
//   - sessions.ts — the ONE substrate-session sidecar protocol (both
//     transports read/write the same resume handle);
//   - verdict.ts — the ONE stop-reason map, the ONE structured-output
//     judge (with the D-E′ REFUSAL VOID: a `stop_reason: 'refusal'`
//     observation voids any structured payload — a refusal never becomes
//     valid output), and the signal predicates.
//
// WHAT STAYS TRANSPORT-SPECIFIC (they are genuinely different substrates):
//   - cli.ts — the headless CLI stream-json path: spawn, the closed-surface
//     argv (--tools ""/--setting-sources ""/--strict-mcp-config + the
//     per-run cq-harness-mcp stdio config), the fail-closed init inventory,
//     the stock mode (EVAL-ONLY);
//   - sdk.ts — the agent-SDK in-process path: lazy feature-detected peer
//     load, `settingSources: []` + `strictMcpConfig: true` (ambient
//     workspace settings and MCP servers structurally excluded), the
//     in-process harness MCP server, the fail-closed init inventory.
//
// PRESERVED INVARIANTS (both transports, unchanged by the merge):
//   - BOTH MCP/output transports (stdio cq-harness-mcp / in-process SDK
//     MCP; --json-schema / outputFormat) — the parity test holds;
//   - settings isolation (no ambient settings, no ambient MCP);
//   - the EXACT production-harness init inventory assertion;
//   - the CQ_* env scrub (default-deny child env, no CQ_* policy knob ever
//     reaches a worker — sandbox/index.ts + shared/proc.ts);
//   - harness session records, the frozen seam types, the strict-budget
//     refusal, the served-model observation + assertion;
//   - the kernel's classifyDispatch/lane table/hard-advisory posture
//     (src/kernel/lanes.ts — untouched; the lane id below is its key).
import type { HarnessConfig } from '../../harness/config.js';
import type { Driver, ModelSpec, OpInvocation, RunOptions, WorkerResult } from '../types.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { RoutingTable } from './routing.js';
import { ClaudeCodeCliTransport } from './cli.js';
import type { CliTransportOptions, SpawnFn } from './cli.js';
import { ClaudeCodeSdkTransport } from './sdk.js';
import type { SdkLoader } from './sdk.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Which substrate path the lane drives. Default 'cli' (CLI primary). */
export type ClaudeCodeTransport = 'cli' | 'sdk';

/** Constructor options — everything optional; defaults are production-real. */
export interface ClaudeCodeDriverOptions {
  /**
   * The substrate path (CONFIGURATION, never a src literal). Default
   * 'cli' — the headless CLI is the primary path; 'sdk' requires the
   * optional peer dependency and fails pre-dispatch without it.
   */
  transport?: ClaudeCodeTransport;
  // --- shared knobs ---
  /** Routing table override (default: defaultRoutingTable — as-of 2026-09 provider docs). */
  routingTable?: RoutingTable;
  /** Sessions directory for the backing SessionStore. Default: the shared durable sessions dir (`defaultSessionsDir()` — item 1.1). */
  sessionsDir?: string;
  /** Harness config — the tool surface + the temp-workspace root. Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /**
   * Extra parent-env NAMES copied into every spawned worker on top of the
   * default-deny allowlist (issue #183). Names only, never values.
   */
  envAllowlist?: readonly string[];
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `computeCostUSD` over the vendored models.dev table). A lookup
   * returning undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  // --- CLI transport knobs (ignored by the sdk transport) ---
  /** The CLI to spawn: a bare command/path, or a full leading-argv template. Default 'claude'. */
  binary?: string | readonly string[];
  /** SIGTERM→SIGKILL grace in ms. */
  termGraceMs?: number;
  /** SIGKILL→force-resolve grace in ms. */
  killGraceMs?: number;
  /**
   * The CLI transport's tool surface: 'harness' (default, the closed
   * surface) or 'stock' — the NULL-HYPOTHESIS EVAL mode only (plan D6),
   * reachable solely by constructing this class directly. Stock mode
   * remains eval-only and is not admissible in production.
   */
  toolSurface?: 'harness' | 'stock';
  /** CLI spawn override hook for tests. Default: the real spawnManaged. */
  spawn?: SpawnFn;
  // --- SDK transport knobs (ignored by the cli transport) ---
  /** SDK module loader override (tests inject a mock). Default: the lazy dynamic import. */
  sdkLoader?: SdkLoader;
}

/**
 * The Claude Code lane on the frozen Driver seam (the lane id is
 * 'claude-code'): one class, two substrate paths, all shared semantics in
 * one place. One instance is stateless across runs (the sdk transport
 * caches only its loaded module), so a single instance can serve many
 * isolated invocations.
 */
export class ClaudeCodeDriver implements Driver {
  private readonly inner: Driver;

  constructor(options: ClaudeCodeDriverOptions = {}) {
    const shared = {
      ...(options.routingTable !== undefined ? { routingTable: options.routingTable } : {}),
      ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.harnessConfig !== undefined ? { harnessConfig: options.harnessConfig } : {}),
      ...(options.envAllowlist !== undefined ? { envAllowlist: options.envAllowlist } : {}),
      ...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
    };
    if (options.transport === 'sdk') {
      this.inner = new ClaudeCodeSdkTransport({
        ...shared,
        ...(options.sdkLoader !== undefined ? { sdkLoader: options.sdkLoader } : {}),
      });
      return;
    }
    // 'cli' is the default; an unknown transport value is a loud
    // construction error (a typo'd config must never silently pick a path).
    if (options.transport !== undefined && options.transport !== 'cli') {
      throw new Error(
        `claude-code driver: transport must be 'cli' or 'sdk', got ${JSON.stringify(options.transport)}`,
      );
    }
    const cliOptions: CliTransportOptions = {
      ...shared,
      ...(options.binary !== undefined ? { binary: options.binary } : {}),
      ...(options.termGraceMs !== undefined ? { termGraceMs: options.termGraceMs } : {}),
      ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
      ...(options.toolSurface !== undefined ? { toolSurface: options.toolSurface } : {}),
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    };
    this.inner = new ClaudeCodeCliTransport(cliOptions);
  }

  /** The frozen seam (v2): run one invocation to completion. */
  run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    return this.inner.run(opInvocation, options);
  }
}
