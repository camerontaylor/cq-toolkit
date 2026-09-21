// Driver seam types — T1.1 types freeze (ADR-0001).
//
// This seam is the worker/driver boundary and is vendor-neutral by
// construction:
//   - Model identity is plain data (a model string + a provider handle),
//     never an SDK model object.
//   - No vendor SDK types appear here; each driver maps these plain-data
//     policies onto its own flags.
//   - This file is self-contained: it must not import from src/kernel. The
//     kernel imports the seam, never the reverse.
//
// Everything except `Driver` itself is plain serializable data; `Driver` is
// the one runtime seam (a run call) and is never persisted.

/**
 * Why a driver run stopped. Frozen values (minimal serializable union):
 *   - `complete` — the driver finished the invocation normally.
 *   - `aborted`  — the run was cancelled before completion (caller abort,
 *                  external signal); no verdict on partial work.
 *   - `budget`   — the driver stopped on a cap it enforces locally (tokens,
 *                  wall clock, turns). USD is never driver-trusted.
 *   - `error`    — the run failed at the driver level.
 */
export type DriverStopReason = 'complete' | 'aborted' | 'budget' | 'error';

/**
 * Token usage for one driver run. Tokens are the source of truth; USD cost
 * is derived downstream from a price map, never reported by drivers.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Tokens spent on reasoning/thinking output, when the driver reports it.
   * ADDITIVE only when the lane's SDK reports reasoning OUTSIDE output; a
   * lane whose SDK counts thinking inside output must not emit this field
   * (every total that sums the frozen Usage fields would double-count).
   */
  reasoning?: number;
}

/**
 * Model identity as plain data: a model string plus a provider handle.
 * `provider` is a plain lowercase handle (e.g. "anthropic", "zai",
 * "deepseek", "openai") resolved per driver — never an SDK model object.
 */
export interface ModelSpec {
  model: string;
  provider: string;
}

/**
 * Tool permission mode. Drivers map this onto their own flags:
 *   - `allowlist`    — only tools named in `allow` may run (the default
 *                      reading when `mode` is omitted).
 *   - `unrestricted` — the driver's full tool surface is available.
 *   - `none`         — no tools at all.
 */
export type ToolPolicyMode = 'allowlist' | 'unrestricted' | 'none';

/**
 * Driver-agnostic tool policy: an allowlist of tool names plus an optional
 * mode. Plain data, serializable.
 */
export interface ToolPolicy {
  /** Allowed tool names. Authoritative in `allowlist` mode; advisory otherwise. */
  allow: readonly string[];
  mode?: ToolPolicyMode;
}

/**
 * Sandbox isolation-level preference. Drivers map this onto their own
 * sandbox flags:
 *   - `none`            — no isolation requested.
 *   - `workspace-write` — writes confined to the workspace.
 *   - `read-only`       — no writes outside driver-managed channels.
 */
export type SandboxLevel = 'none' | 'workspace-write' | 'read-only';

/** Driver-agnostic sandbox policy: an isolation-level preference. Plain data, serializable. */
export interface SandboxPolicy {
  level: SandboxLevel;
}

/** Budget caps a caller attaches to one invocation. All optional; plain data. */
export interface Budget {
  maxUsd?: number;
  maxTokens?: number;
  wallClockMs?: number;
  maxAttempts?: number;
}

/** One invocation of a worker: everything a driver needs to run the prompt. Plain data, serializable. */
export interface OpInvocation {
  prompt: string;
  modelSpec: ModelSpec;
  toolPolicy: ToolPolicy;
  sandboxPolicy: SandboxPolicy;
  /** Opaque driver session handle for multi-turn continuation, when the driver supports sessions. */
  sessionRef?: string;
  budget: Budget;
}

/** Record of one denied tool use. */
export interface ToolDenial {
  tool: string;
  reason: string;
}

/**
 * What a worker run returned. Plain data, serializable. `costUSD` is
 * OPTIONAL and derived-only: callers compute it from a price map over
 * `usage`; drivers never report trusted USD.
 */
export interface WorkerResult {
  /**
   * The model id the SERVED response reports — observed, never requested.
   * A gateway may silently serve a different model than `ModelSpec.model`
   * asks for (the silent-remap footgun); drivers surface the id their lane
   * reports on the response, and the shared driver-conformance suite fails
   * loudly when it is absent or differs from the requested model. Optional:
   * a lane that cannot observe it reports nothing rather than a guess.
   */
  model?: string;
  structuredOutput?: unknown;
  usage: Usage;
  costUSD?: number;
  /**
   * What `costUSD` is, when it is present (DD-9): `modeled` — an
   * api-equivalent figure derived from usage through a list-price map (a
   * comparable proxy, NOT an invoice: a subscription-routed run's marginal
   * cost is not this number); `billed` — reserved for a lane whose provider
   * reports actual invoiced cost (none in v1). A result that carries no
   * costUSD carries no basis either.
   */
  costBasis?: 'modeled' | 'billed';
  sessionId?: string;
  denials: ToolDenial[];
  /**
   * Underlying failure cause, when the driver caught one. Present only on a
   * driver-level failure verdict (stopReason 'error'), as a NON-EMPTY message.
   * Drivers truncate (<= 500 chars) and secret-redact the cause before
   * assigning it; it is never used to turn a driver failure into a model
   * score.
   */
  error?: string;
  stopReason: DriverStopReason;
}

/** The driver seam: run one invocation to completion. The only runtime (non-data) type in this file. */
export interface Driver {
  run(opInvocation: OpInvocation): Promise<WorkerResult>;
}
