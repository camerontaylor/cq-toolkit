// Driver seam types — T1.1 types freeze (ADR-0001), seam v2 (ADR-0002).
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
// the one runtime seam (a run call) and is never persisted. The v2 additions
// (ADR-0002) keep that split: structured-output and workspace requests ride
// the invocation (plain data, schema-mirrored), while the cancellation
// signal and the budget reservation ride the runtime-only `RunOptions`
// second parameter (never persisted, hashed, or schema-mirrored).

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

/** A JSON Schema (draft 2020-12) document, plain data. No external $ref; meta-schema URIs stripped. */
export type JsonSchema = { readonly [key: string]: unknown };

/** Structured-output request: plain data, hashable, lane-neutral. */
export interface OutputSchema {
  /** Stable contract name, e.g. 'review.fixItem/v1' — journalled and used in diagnostics. */
  name: string;
  schema: JsonSchema;
}

/** The directory the worker edits. The driver binds cwd and harness confinement to realpath(path). */
export interface WorkspaceBinding {
  /** Absolute path to an existing directory. */
  path: string;
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
  /**
   * When set, the run must end with a schema-valid structuredOutput or an
   * 'output-invalid' error (ADR-0002 §2.3).
   */
  outputSchema?: OutputSchema;
  /** Workspace binding (ADR-0002 §2.4). Absent → I6 fresh temp workspace, unchanged. */
  workspace?: WorkspaceBinding;
}

/**
 * Runtime-only per-call options. Never persisted, hashed, or schema-mirrored.
 * Rides the optional second `run` parameter (the `fetch(url, {signal})`
 * idiom), not the invocation, so `OpInvocation` stays pure data.
 */
export interface RunOptions {
  /**
   * Cooperative cancellation. `| undefined` so `{ signal: ctx?.signal }`
   * compiles under exactOptionalPropertyTypes.
   */
  signal?: AbortSignal | undefined;
  /**
   * Budget reservation of the governing gate (ADR-0003 §2.2). Runtime-only,
   * next to the signal. Drivers MAY ignore it.
   */
  reservation?: BudgetReservation | undefined;
}

/**
 * Plain data; field set owned by ADR-0003 §2.2, declared here so the driver
 * family needs no kernel import.
 */
export interface BudgetReservation {
  id: string;
  usd?: number;
  tokens?: number;
  overshootUsd: number;
  class: 'hard' | 'advisory';
}

/** Record of one denied tool use. */
export interface ToolDenial {
  tool: string;
  reason: string;
}

/**
 * Structured class of a driver-level failure verdict. Classes come from
 * structured signals (HTTP status or SDK error class, CLI exit code/signal,
 * protocol fields); free-text matching is allowed only where the vendor
 * exposes no structure, and only with anchored patterns. Anything unresolved
 * is `unknown`, never guessed into another class.
 */
export type WorkerErrorClass =
  /** outputSchema requested; object missing, unparseable, or schema-invalid (a MODEL outcome). */
  | 'output-invalid'
  /** Set only by the shared served-model wrapper (ADR-0002 §2.6). */
  | 'served-model-mismatch'
  /** Network reset, timeout, 5xx/overloaded — retry may succeed. */
  | 'transient'
  /** Throttling: retryable with backoff (RS-14 §4; e.g. 429 WITH retry-after). */
  | 'rate-limit'
  /** Funded-allowance exhaustion: defer-until-reset if a reset is known, else needs-human (RS-14 §4). */
  | 'quota'
  /** Credentials rejected at the provider (401/403). */
  | 'auth'
  /** Any other provider-reported permanent failure (RS-14's name). */
  | 'provider-error'
  /** Local failure: spawn/exit/crash, protocol break, oversized frame, session I/O. */
  | 'harness'
  /** Could not be classified from a structured signal — never guessed. */
  | 'unknown';

/**
 * Provider limit observations (plain data, RS-14 §1/§4). Lanes populate what
 * the vendor exposes; ops never read them.
 */
export interface ProviderSignals {
  /** From a Retry-After (or vendor equivalent) on this response. */
  retryAfterMs?: number;
  /** Every limit window the provider reported on this response; several may be live at once. */
  windows?: Array<{
    /**
     * Provider window id, e.g. '5h' | '7d' (claude unified-*), 'rolling' | 'weekly' | 'monthly'
     * (opencode-go), 'requests' | 'tokens' (per-minute API headers).
     */
    id: string;
    /** Fraction of the window used, 0–1 (percent sources are divided by 100). */
    utilization?: number;
    /** Remaining requests/tokens, where the provider reports counts (Anthropic API, OpenAI). */
    remaining?: { requests?: number; tokens?: number };
    /** ISO-8601 instant this window resets. */
    resetAt?: string;
  }>;
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
   * Drivers truncate the cause to a bounded length (500 chars plus a
   * truncation marker) and secret-redact it before assigning it; it is never
   * used to turn a driver failure into a model score.
   */
  error?: string;
  /**
   * Structured failure class (seam v2). Only on stopReason === 'error' (same
   * one-directional wire rule as `error`: present ⇒ the verdict is 'error';
   * an 'error' verdict without one still parses, so v1 records and
   * pre-S3 producers stay valid).
   */
  errorClass?: WorkerErrorClass;
  /**
   * Provider limit observations (seam v2). Allowed on ANY stopReason — a
   * rate-limited run that also exhausted its budget still reports what the
   * vendor exposed. Field set closed at seam-v2 acceptance.
   */
  providerSignals?: ProviderSignals;
  stopReason: DriverStopReason;
}

/**
 * The driver seam: run one invocation to completion. The only runtime
 * (non-data) type in this file. The optional second parameter is additive: a
 * v1 implementation `run(invocation)` remains assignable to this interface —
 * such a driver just ignores cancellation, which conformance leg b-iii
 * catches.
 */
export interface Driver {
  run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult>;
}

/**
 * The seam contract version (ADR-0002 §2.8): bumped once per frozen surface
 * change, shared with the runner and journal consumers of the seam. v2 adds
 * outputSchema/workspace on the invocation, RunOptions on run, and
 * errorClass/providerSignals on the result.
 */
export const SEAM_VERSION = 2;
