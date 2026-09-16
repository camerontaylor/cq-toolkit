// ACP wire vocabulary — T1.8 (OUR protocol types; the driver boundary).
//
// I10 BOUNDARY: this file is the acp lane's ENTIRE protocol surface. It
// imports NOTHING from @agentclientprotocol/sdk or any vendor package —
// every shape below was transcribed from the LIVE probes
// (scripts/probe-acp.mjs against zcode-acp-server@0.37.3 /
// @agentclientprotocol/sdk 1.4.0, recorded in docs/acp-driver-strategy.md
// "Live-probe evidence") and the ACP v1 spec
// (https://agentclientprotocol.com /protocol/v1/*, fetched 2026-09-15).
// The vendor's vocabulary DIES HERE: the driver folds these frames into
// the tagged kinds at the bottom of this file, and nothing vendor-shaped
// crosses into src/driver/acp/index.ts.
//
// TRANSPORT (probe-confirmed): newline-delimited JSON-RPC 2.0 over stdio —
// one JSON object per line, requests carry numeric ids, notifications
// carry none, and a response is any frame with an id plus a result or
// error member.
//
// THE TWO SHAPE PINS the live probes pinned (strategy §1.1 item 5, §5):
//   - session/update payloads are NESTED — the discriminating kind lives
//     at `params.update.sessionUpdate` (text at `params.update.content`),
//     never at `params.sessionUpdate.*`.
//   - the served model rides `configOptions[]` entries with
//     `id: 'model'` / `category: 'model'` and a `currentValue` formatted
//     `providerId\modelId` (backslash separator, the vendor's own
//     encoding). The session/new value is the LAZY default; the
//     `config_option_update` value is the MATERIALIZED truth — the
//     driver folds only the latter (leg m reads post-materialization).
//
// DEFENSIVE POSTURE: every inbound shape is parsed with zod and may FAIL
// — an unshapeable frame is narration evidence in the driver, never a
// crash. Schemas here are deliberately LOOSE (unknown members ride
// along): the vendor may add fields; the fold reads only what it knows.
import { z } from 'zod';
import type { Usage } from '../types.js';

// ---------------------------------------------------------------------------
// Constants — the version that binds is the wire integer (strategy §3)
// ---------------------------------------------------------------------------

/** The protocol version THIS client speaks; initialize sends exactly this. */
export const ACP_PROTOCOL_VERSION = 1;

/** The ACP error code for "authenticate first" — pass-through-unless-demanded (OQ-1: no gate on the reference vendor). */
export const AUTH_REQUIRED_ERROR_CODE = -32000;

/**
 * Method names — the strategy §1.2 subset, the two inbound-only methods,
 * and the §6 resume gate's middle rung (`unstable_resumeSession`, the
 * reference's own name for the resume-when-`sessionCapabilities.resume`
 * request — a method name carrying the session id in params).
 */
export const ACP_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  unstableResumeSession: 'unstable_resumeSession',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetConfigOption: 'session/set_config_option',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
} as const;

/** The mode-pin request targets this config id (strategy §1.2 amendment). */
export const MODE_CONFIG_ID = 'mode';
/** …and pins the session into this mode — the mode whose permission gate fires (OQ-4). */
export const GATING_MODE = 'build';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 frames
// ---------------------------------------------------------------------------

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Client → agent request (id rides; response expected). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** Client → agent notification (no id; session/cancel is the one we send). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: JsonRpcErrorObject;
}

export type JsonRpcOutboundFrame =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

/**
 * Any inbound line, parsed defensively. A frame is a RESPONSE when it has
 * an id plus result/error; a server→client REQUEST when method + id; a
 * NOTIFICATION when method alone. Anything else is junk → narration.
 */
export const InboundFrameSchema = z.looseObject({
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type InboundFrame = z.infer<typeof InboundFrameSchema>;

export const JsonRpcErrorObjectSchema = z.looseObject({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** A rejected request: the JSON-RPC error object preserved for the caller. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(`acp rpc error ${error.code}: ${error.message}`);
    this.name = 'AcpRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** True when a request failure is the agent demanding authentication (OQ-1 posture: fail loud, name the methods). */
export function isAuthRequiredError(err: unknown): boolean {
  return err instanceof AcpRpcError && err.code === AUTH_REQUIRED_ERROR_CODE;
}

// ---------------------------------------------------------------------------
// Inbound: session/update — the NESTED union (probe shape pin), as OUR kinds
// ---------------------------------------------------------------------------

export const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

export const ConfigOptionSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  currentValue: z.unknown().optional(),
});

export type ConfigOption = z.infer<typeof ConfigOptionSchema>;

/** The session/update PARAMS (kind discriminator NESTED at update.sessionUpdate — the driver parses params, not the frame). */
export const SessionUpdateParamsSchema = z.looseObject({
  sessionId: z.string().optional(),
  update: z.record(z.string(), z.unknown()),
});

// Per-kind schemas — loose on purpose (unknown members ride along).

const AgentMessageChunkSchema = z.looseObject({
  sessionUpdate: z.literal('agent_message_chunk'),
  content: ContentBlockSchema.optional(),
});

const AgentThoughtChunkSchema = z.looseObject({
  sessionUpdate: z.literal('agent_thought_chunk'),
  content: ContentBlockSchema.optional(),
});

const ToolCallStartSchema = z.looseObject({
  sessionUpdate: z.literal('tool_call'),
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.unknown().optional(),
});

const ToolCallProgressSchema = z.looseObject({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string(),
  status: z.string().optional(),
  // rawOutput accepts ANY JSON value (review-debt #49): a conforming agent
  // may report an object, array, number, or boolean here — the old
  // string-only schema rejected the ENTIRE tool_call_update, losing the
  // terminal status AND the output. Non-strings are serialized at this
  // boundary (rawOutputToText below); the driver sees a string, as before.
  rawOutput: z.unknown().optional(),
  // The tool's result CONTENT blocks (the spec's ContentBlock[]; the
  // reference vendor reports a SUCCESSFUL tool result here, rawOutput
  // riding only on some failure shapes — Codex P2). The text of the text
  // blocks is lifted at this boundary (contentText below); the vendor's
  // block vocabulary dies here, never crossing into the driver.
  content: z.array(ContentBlockSchema).optional(),
});

const ConfigOptionsUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('config_option_update'),
  configOptions: z.array(ConfigOptionSchema).optional(),
});

const CurrentModeUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('current_mode_update'),
  currentModeId: z.string().optional(),
});

const UsageContextUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('usage_update'),
});

/**
 * The session/update union as OUR discriminated shapes — the vendor's
 * `sessionUpdate` literals are translated ONCE here and never appear in
 * the driver (strategy §6: the update union dies at the driver boundary).
 * `parseAcpUpdate` yields undefined for an unshapeable update: narration,
 * never a crash. Known kinds the seam cannot carry (plans, command
 * palettes, user-echo, context telemetry) parse as `known-unconsumed` and
 * are DROPPED silently — narration is reserved for genuinely unshapeable
 * frames, so a clean run persists no narration at all.
 */
export type AcpUpdate =
  | { kind: 'agent_message_chunk'; text: string }
  | { kind: 'agent_thought_chunk'; text: string }
  | {
      kind: 'tool_call';
      toolCallId: string;
      title?: string;
      toolKind?: string;
      status?: string;
      rawInput?: unknown;
    }
  | {
      kind: 'tool_call_update';
      toolCallId: string;
      status?: string;
      /** Wire rawOutput as TEXT — a non-string JSON value (object/array/number/boolean) serialized at this boundary (review-debt #49). */
      rawOutput?: string;
      /** The content blocks' text (text-typed blocks joined in order), when non-empty — the fallback output the fold reads when rawOutput is absent. */
      contentText?: string;
    }
  | { kind: 'config_option_update'; configOptions?: ConfigOption[] }
  | { kind: 'current_mode_update'; currentModeId?: string }
  | { kind: 'usage_update' }
  | { kind: 'known-unconsumed'; sessionUpdate: string };

/** Parse ONE nested update payload into our tagged kind; undefined = unshapeable (narration). */
export function parseAcpUpdate(update: unknown): AcpUpdate | undefined {
  const kind = asString(asRecord(update)?.['sessionUpdate']);
  switch (kind) {
    case 'agent_message_chunk': {
      const parsed = AgentMessageChunkSchema.safeParse(update);
      return parsed.success
        ? { kind: 'agent_message_chunk', text: parsed.data.content?.text ?? '' }
        : undefined;
    }
    case 'agent_thought_chunk': {
      const parsed = AgentThoughtChunkSchema.safeParse(update);
      return parsed.success
        ? { kind: 'agent_thought_chunk', text: parsed.data.content?.text ?? '' }
        : undefined;
    }
    case 'tool_call': {
      const parsed = ToolCallStartSchema.safeParse(update);
      return parsed.success
        ? {
            kind: 'tool_call',
            toolCallId: parsed.data.toolCallId,
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(parsed.data.kind !== undefined ? { toolKind: parsed.data.kind } : {}),
            ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
            ...(parsed.data.rawInput !== undefined ? { rawInput: parsed.data.rawInput } : {}),
          }
        : undefined;
    }
    case 'tool_call_update': {
      const parsed = ToolCallProgressSchema.safeParse(update);
      if (!parsed.success) return undefined;
      const contentText = textOfContentBlocks(parsed.data.content ?? []);
      return {
        kind: 'tool_call_update',
        toolCallId: parsed.data.toolCallId,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.rawOutput !== undefined
          ? { rawOutput: rawOutputToText(parsed.data.rawOutput) }
          : {}),
        ...(contentText !== '' ? { contentText } : {}),
      };
    }
    case 'config_option_update': {
      const parsed = ConfigOptionsUpdateSchema.safeParse(update);
      return parsed.success
        ? {
            kind: 'config_option_update',
            ...(parsed.data.configOptions !== undefined
              ? { configOptions: parsed.data.configOptions }
              : {}),
          }
        : undefined;
    }
    case 'current_mode_update': {
      const parsed = CurrentModeUpdateSchema.safeParse(update);
      return parsed.success
        ? {
            kind: 'current_mode_update',
            ...(parsed.data.currentModeId !== undefined
              ? { currentModeId: parsed.data.currentModeId }
              : {}),
          }
        : undefined;
    }
    case 'usage_update': {
      // Context occupancy telemetry, NOT turn tokens (strategy §1.3) — consumed and dropped.
      return UsageContextUpdateSchema.safeParse(update).success
        ? { kind: 'usage_update' }
        : undefined;
    }
    // Known union members the frozen seam cannot carry — parse as
    // known-unconsumed (dropped silently), never narration.
    case 'user_message_chunk':
    case 'plan':
    case 'session_info_update':
    case 'available_commands_update':
      return { kind: 'known-unconsumed', sessionUpdate: kind };
    case undefined:
    default:
      return undefined; // unknown or unshapeable — the caller narrates
  }
}

// ---------------------------------------------------------------------------
// Inbound: session/request_permission — options + the FULL answer table
// ---------------------------------------------------------------------------

export const PermissionOptionKindSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;

/**
 * One offered permission option. THE PROBE FACT that shapes this lane:
 * optionIds are VENDOR STRINGS ("allow_once", "allow_project", "deny" on
 * zcode-acp-server) — selection is by KIND, and the chosen option's OWN
 * optionId is echoed back, never a spec-shaped id assumed.
 */
export const PermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  kind: PermissionOptionKindSchema,
  name: z.string().optional(),
});

export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

/**
 * The inbound request's params (the toolCall mirrors the probe: title
 * leads with the tool name, kind ABSENT on the reference vendor).
 * `sessionId` stays WIRE-optional (vendor-verbatim) — the HANDLER enforces
 * the scope: an ask that does not name the run's active session exactly
 * is rejected before any answer-table or evidence effects (PR #37
 * review, Codex P2).
 */
export const RequestPermissionParamsSchema = z.looseObject({
  sessionId: z.string().optional(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    rawInput: z.unknown().optional(),
  }),
  options: z.array(PermissionOptionSchema),
});

export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>;

/**
 * The client's answer to a permission request — the RPC result is
 * `{ outcome: <Outcome> }` wrapping the Outcome object (probe verbatim:
 * `result.outcome.outcome === 'selected'` + `result.outcome.optionId`).
 */
export interface PermissionAnswer {
  outcome: {
    outcome: 'selected';
    optionId: string;
  };
}

/**
 * ALLOW side of the FULL answer table (strategy §2.1): `allow_once` when
 * offered, else `allow_always` (`allow_always` is harmless per-run — the
 * session dies with the process, so there is no cross-run memory).
 */
export function selectAllowOptionId(options: readonly PermissionOption[]): string | undefined {
  const chosen =
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always');
  return chosen?.optionId;
}

/**
 * DENY side of the answer table: `reject_once` when offered, else
 * `reject_always`. UNDEFINED when the vendor offered no reject option at
 * all — the strategy §2.1 case that FAILS THE RUN (never answer
 * `cancelled`; that outcome is only legal on a real cancellation).
 */
export function selectRejectOptionId(options: readonly PermissionOption[]): string | undefined {
  const chosen =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always');
  return chosen?.optionId;
}

export type PermissionDecision = 'allow' | 'deny';

/**
 * The answer-table application: resolve a decision to an optionId, or
 * report the FAILED SIDE plus the offered options when the required side
 * was not offered (a deny with no reject option — or an allow with no
 * allow option — fails the run; the caller names the side and the
 * options).
 */
export function selectPermissionAnswer(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
):
  | { ok: true; answer: PermissionAnswer }
  | { ok: false; offered: readonly PermissionOption[]; side: PermissionDecision } {
  const optionId =
    decision === 'allow' ? selectAllowOptionId(options) : selectRejectOptionId(options);
  if (optionId === undefined) {
    return { ok: false, offered: options, side: decision };
  }
  return { ok: true, answer: { outcome: { outcome: 'selected', optionId } } };
}

/**
 * The permission request's matched tool IDENTITY (strategy §2.1's matching
 * gap, narrowed by the probe): the vendor's title leads with the tool name
 * as `<toolName>: <summary>` (capped at 80 chars on the reference vendor),
 * and `kind` is ABSENT from the request's toolCall. v1 matches the
 * leading token of the title; an empty title falls back to `kind`; both
 * absent → 'unknown' (which an allowlist never contains — fail-closed).
 */
export function permissionToolIdentity(
  title: string | undefined,
  kind: string | undefined,
): string {
  const trimmed = title?.trim() ?? '';
  if (trimmed !== '') {
    const separator = trimmed.indexOf(': ');
    const lead = separator === -1 ? trimmed : trimmed.slice(0, separator);
    return lead.trim() !== '' ? lead.trim() : 'unknown';
  }
  const trimmedKind = kind?.trim() ?? '';
  return trimmedKind !== '' ? trimmedKind : 'unknown';
}

// ---------------------------------------------------------------------------
// Inbound: the handshake + prompt-response wire shapes
// ---------------------------------------------------------------------------

export const InitializeResultSchema = z.looseObject({
  protocolVersion: z.number(),
  agentInfo: z
    .looseObject({
      name: z.string().optional(),
      title: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  authMethods: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  agentCapabilities: z
    .looseObject({
      loadSession: z.unknown().optional(),
      // Probe-verbatim (2026-09-15): `sessionCapabilities: { list: {},
      // resume: {}, fork: {} }` INSIDE agentCapabilities — the §6 resume
      // gate's middle rung reads `resume` (advertised = the member is
      // present, however empty).
      sessionCapabilities: z
        .looseObject({
          list: z.unknown().optional(),
          resume: z.unknown().optional(),
          fork: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type InitializeResult = z.infer<typeof InitializeResultSchema>;

/**
 * The session modes block, shared by session/new and set_config_option.
 * `availableModes` entries are OBJECTS `{ id, name }` on the live wire —
 * probe-verbatim 2026-09-15: `[{ id: 'plan', name: 'Plan' }, …]` (the spec's
 * SessionMode). An earlier transcription pinned bare strings; the LIVE
 * session/new parse threw on the first eval-cell run (the failed-with-
 * evidence record, docs/eval-axes-demo.md) while the fake fixture — emitting
 * strings — had matched the bug. `currentModeId` IS a bare string (probe:
 * the `current_mode_update` value).
 */
const SessionModesSchema = z.looseObject({
  currentModeId: z.string().optional(),
  availableModes: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});

export const SessionNewResultSchema = z.looseObject({
  sessionId: z.string(),
  modes: SessionModesSchema.optional(),
  configOptions: z.array(ConfigOptionSchema).optional(),
});

export type SessionNewResult = z.infer<typeof SessionNewResultSchema>;

/** set_config_option's answer carries the same modes/configOptions shape (no sessionId member). */
export const SetConfigOptionResultSchema = z.looseObject({
  modes: SessionModesSchema.optional(),
  configOptions: z.array(ConfigOptionSchema).optional(),
});

export const PromptResponseSchema = z.looseObject({
  stopReason: z.string(),
  usage: z.unknown().optional(),
});

export type PromptResponse = z.infer<typeof PromptResponseSchema>;

/**
 * The PromptResponse.usage wire shape, VERBATIM from the live probe (OQ-3):
 * `{ totalTokens, inputTokens, outputTokens, thoughtTokens,
 * cachedReadTokens, cachedWriteTokens }`. The SDK marks the field
 * UNSTABLE; the published v1 schema page omits it — both facts recorded,
 * neither changes the fold.
 *
 * Every token field is constrained to a finite non-negative integer (PR
 * #37 review, Codex P2) — the same requirement the CLI lanes impose
 * before accounting. A negative or fractional count from a broken
 * harness makes the whole usage UNSHAPEABLE (mapWireUsage → undefined,
 * no measurement), never a corrupted fold: a negative count must not
 * drag totalTokensOf() below Budget.maxTokens or produce a negative
 * modeled cost. zod's .int() rejects NaN and ±Infinity by definition.
 */
export const UsageWireSchema = z.looseObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedReadTokens: z.number().int().nonnegative().optional(),
  cachedWriteTokens: z.number().int().nonnegative().optional(),
  thoughtTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

/**
 * Wire usage → frozen Usage: outputTokens → output, cachedReadTokens →
 * cacheRead, cachedWriteTokens → cacheWrite (the step-2 correction: the
 * field EXISTS on this wire and folds), and input = inputTokens −
 * cachedReadTokens − cachedWriteTokens (floored at 0).
 *
 * THE SUBTRACTION (the cache-bucket fix): the wire's inputTokens is
 * INCLUSIVE of the cached tokens — the committed live sample proves the
 * overlap: `{ totalTokens: 15722, inputTokens: 15719, outputTokens: 3,
 * cachedReadTokens: 11648, cachedWriteTokens: 0 }` has totalTokens =
 * inputTokens + outputTokens, so 11648 of the 15719 ARE the cached reads
 * (an exclusive input would have totaled 27370). Mapping inputTokens
 * straight through double-counted cache in every total that sums the
 * frozen Usage fields (Budget.maxTokens, the DD-9 rollup) — the exact
 * defect class the ai-sdk lane fixed via `inputTokenDetails.noCacheTokens`
 * (src/driver/ai-sdk/index.ts, usageFromSdk). The derived input keeps
 * cacheRead/cacheWrite as the breakdown terms, so Σ of the frozen fields
 * equals the wire's own totalTokens: 15719 − 11648 − 0 = 4071, and
 * 4071 + 3 + 11648 + 0 = 15722.
 *
 * `reasoning` is deliberately NOT emitted: `thoughtTokens` exists on the
 * wire but its ADDITIVITY is unknown (inside or outside outputTokens —
 * the probed turn reported 0, so the wire cannot say), and the frozen
 * field is additive-only-when-reported-outside-output. Same rule as the
 * claude-agent lane: an unproven-additive count stays unlifted (strategy
 * §2.3, step-2 correction).
 *
 * An unshapeable usage (or `usage: null` — the probed cancelled response)
 * is NO measurement: undefined, never zeros-that-look-measured.
 */
export function mapWireUsage(raw: unknown): Usage | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = UsageWireSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const cacheRead = parsed.data.cachedReadTokens ?? 0;
  const cacheWrite = parsed.data.cachedWriteTokens ?? 0;
  return {
    input: Math.max(0, parsed.data.inputTokens - cacheRead - cacheWrite),
    output: parsed.data.outputTokens,
    cacheRead,
    cacheWrite,
  };
}

/**
 * The model option's CURRENT value from a configOptions array — the entry
 * with `id: 'model'` (category `'model'` accepted as the fallback match).
 * Returns undefined for an absent/empty/non-string value. THE CALLER
 * decides WHICH configOptions to consult: session/new's are the LAZY
 * defaults (never surfaced); only the `config_option_update` value is the
 * materialized truth (strategy §5 shape pin).
 */
export function modelOptionValueFrom(
  configOptions: readonly ConfigOption[] | undefined,
): string | undefined {
  const option = configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model');
  const value = option?.currentValue;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Small defensive readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The rawOutput fold at the protocol boundary (review-debt #49): a string
 * rides verbatim; any other JSON value (object, array, number, boolean,
 * null) is serialized — the same extraction posture as textOfContentBlocks
 * below, the vendor's value vocabulary dying here so the driver folds a
 * string. A value JSON.stringify cannot represent (parse output never
 * cycles; only a hostile hand-built frame could) falls back to String().
 */
export function rawOutputToText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The text of a tool_call_update's content blocks: the text-typed blocks'
 * `text` members joined in order — the same extraction the subprocess lane
 * applies to tool_result content (textOfContent there; Codex P2 here).
 * Resource/image/audio/resource_link blocks carry no text and contribute
 * nothing; an absent or empty array yields ''.
 */
function textOfContentBlocks(blocks: readonly z.infer<typeof ContentBlockSchema>[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}
