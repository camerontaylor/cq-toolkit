// The SMALLEST text-only GLM-5.3-FLASH strict pre-request capability for the
// ZAI provider route — C2. FAIL-CLOSED BY DEFAULT and NO invented proof.
//
// WHAT THIS IS. A dedicated capability module for the ZAI chat route
// (`https://api.z.ai/api/coding/paas/v4`, model `glm-5.3-flash`) whose `count`
// returns a PROVEN CONSERVATIVE upper bound on the model's INPUT TOKENS:
//
//   count(serialized) = utf8Bytes(renderGlmTextPrompt(projection))
//
// Token count ≤ UTF-8 bytes for a byte-level BPE vocabulary (each ordinary text
// token consumes at least one input byte), so the rendered literal length is a
// safe bound and every emitted special-token/framing literal is PAID in those
// bytes (at least one byte each). There is NO guessed multiplier, NO padding
// and NO byte-count fallback.
//
// THE RENDER IS BUILT FROM PRIMARY SOURCES, NOT GUESSED:
//   - stage 1 reproduces the pinned @ai-sdk/openai-compatible 3.0.48 chat
//     message/tool conversion (`convertToOpenAICompatibleChatMessages`,
//     `prepareTools`) plus the @ai-sdk/zai 3.0.10 request-body transform;
//   - stage 2 renders the ACTUAL publisher template skeleton at
//     `zai-org/GLM-5.3-FLASH` revision 91b69215804f2d2036a8867f6ce44848e278dcda
//     (chat_template.jinja, 10950 bytes, sha256
//     0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5).
//
// WHAT IT REFUSES (throws `UnboundedGlmRequestShape`): any shape the renderer
// cannot reproduce exactly — non-text content parts, hosted/provider tools,
// images/audio/video/files, unknown or cap-changing provider options, a
// response-format request the publisher template does not render (see below),
// and `thinking.type: 'disabled'` (GLM-5.3 thinking CANNOT be disabled).
//
// CONSERVATIVE, NOT YET BYTE-EXACT. The renderer reproduces the template's
// STRUCTURE and every dynamic value, and it renders Jinja `tojson` with the
// HTML escapes (`<>&'` -> \uXXXX) and the wider `", "`/`": "` separators, so
// its byte length is an UPPER BOUND of the hosted Jinja rendering — it never
// omits content or under-counts. A byte-exact comparison against a pinned Jinja
// runtime (and the public 20MB tokenizer) is still required before any claim of
// exactness; that comparison is a named gap, not an asserted proof.
//
// WHAT IS *ABSENT* UNTIL AN EXTERNAL CONTRACT EXISTS. `createGlmTextCapability`
// returns `undefined` unless the caller supplies a `GlmHostedTransformAttestation`
// from a TRUSTED operator/host adapter (never from worker config, request body
// or a model-name flag). The attestation states the hosted transform matches
// this pinned render and that `max_tokens` caps ALL generated reasoning + text
// + tool arguments with no unreserved hidden generation/retry. Short of that,
// the capability is missing and the driver refuses — model names/booleans never
// enable it.
import { Buffer } from 'node:buffer';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { StrictTokenCapability } from './pre-request-ceiling.js';

// ---------------------------------------------------------------------------
// Pinned profile
// ---------------------------------------------------------------------------

/** Exact pinned identities this capability is bound to (no aliases/route drift). */
export interface GlmTextProfilePins {
  readonly provider: 'zai';
  readonly model: 'glm-5.3-flash';
  readonly endpoint: 'https://api.z.ai/api/coding/paas/v4';
  readonly requestPath: '/chat/completions';
  readonly packages: {
    readonly zai: { readonly name: '@ai-sdk/zai'; readonly version: '3.0.10' };
    readonly openAiCompatible: {
      readonly name: '@ai-sdk/openai-compatible';
      readonly version: '3.0.48';
    };
  };
  readonly publisherTemplate: {
    readonly repo: 'zai-org/GLM-5.3-FLASH';
    readonly revision: '91b69215804f2d2036a8867f6ce44848e278dcda';
    readonly sha256: '0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5';
    readonly bytes: 10950;
  };
  readonly publisherTokenizerRevision: '91b69215804f2d2036a8867f6ce44848e278dcda';
}

export const GLM_TEXT_PROFILE: GlmTextProfilePins = {
  provider: 'zai',
  model: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/coding/paas/v4',
  requestPath: '/chat/completions',
  packages: {
    zai: { name: '@ai-sdk/zai', version: '3.0.10' },
    openAiCompatible: { name: '@ai-sdk/openai-compatible', version: '3.0.48' },
  },
  publisherTemplate: {
    repo: 'zai-org/GLM-5.3-FLASH',
    revision: '91b69215804f2d2036a8867f6ce44848e278dcda',
    sha256: '0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5',
    bytes: 10950,
  },
  publisherTokenizerRevision: '91b69215804f2d2036a8867f6ce44848e278dcda',
};

// ---------------------------------------------------------------------------
// External hosted-transform attestation (the ONLY activation gate)
// ---------------------------------------------------------------------------

/**
 * The externally supplied hosted-transform contract. Supplied by a TRUSTED
 * operator/host adapter — NEVER derived from worker config, an HTTP body or a
 * model-name/boolean flag. It carries no numeric expansion and no callback: the
 * byte bound comes from the pinned renderer below.
 *
 * It optionally carries a `responseFormatTransform` ONLY when the actual host
 * adds a complete, known instruction/schema transform for `response_format`
 * (the publisher chat template does NOT render one). Absent it, any non-null
 * response-format request is REFUSED — the HTTP `response_format` field is
 * never silently dropped from the prompt bound.
 */
export interface GlmHostedTransformAttestation {
  readonly provider: 'zai';
  readonly model: 'glm-5.3-flash';
  /** Exact hosted endpoint (base URL without the request path). */
  readonly endpoint: 'https://api.z.ai/api/coding/paas/v4';
  /** Non-empty hosted build/route identity. */
  readonly hostedBuild: string;
  readonly templateRevision: '91b69215804f2d2036a8867f6ce44848e278dcda';
  readonly tokenizerRevision: '91b69215804f2d2036a8867f6ce44848e278dcda';
  /** `max_tokens` caps ALL generated reasoning + visible text + tool arguments. */
  readonly reasoningInclusiveMaxTokens: true;
  /** No unreserved hidden generation or transport retry. */
  readonly noUnreservedHiddenGeneration: true;
  /**
   * Present ONLY when the host renders `response_format` into the model input
   * with a COMPLETE known transform; `renderInstructionBytes` is the exact
   * proven byte expansion it adds for a given schema document. Absent => any
   * response format is refused.
   */
  readonly responseFormatTransform?: {
    readonly renderInstructionBytes: (schemaJson: string) => number;
  };
  /** Display-only label. */
  readonly provenance: string;
}

/** The caller's resolved model identity (from the run's ModelSpec). */
export interface GlmCapabilityInput {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/** A request shape this capability cannot bound — refused, never under-counted. */
export class UnboundedGlmRequestShape extends Error {
  constructor(detail: string) {
    super(`glm-5.3-flash capability: unsupported request shape — ${detail}`);
    this.name = 'UnboundedGlmRequestShape';
  }
}

// ---------------------------------------------------------------------------
// Restricted-shape validation + exact rendering
// ---------------------------------------------------------------------------

/** The pinned ZAI provider-option keys (from @ai-sdk/zai 3.0.10). */
const ZAI_OPTION_KEYS = new Set([
  'doSample',
  'thinking',
  'reasoningEffort',
  'toolStream',
  'requestId',
  'userId',
]);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new UnboundedGlmRequestShape(`${where} must be an array`);
  return value;
}

/** UTF-8 byte length of one rendered literal. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Jinja `| tojson(ensure_ascii=False)` — RENDERED CONSERVATIVELY, never shorter
 * than the hosted Jinja output. Jinja's htmlsafe JSON escapes `<`, `>`, `&` and
 * `'` as `\uXXXX` and uses `", "` / `": "` separators; a compact
 * `JSON.stringify` would UNDER-count both, which is unsafe. This renderer emits
 * the HTML escapes AND the wider separators (and preserves non-ASCII as UTF-8),
 * so its byte length is an upper bound for the hosted rendering.
 */
function escapeJinjaString(jsonString: string): string {
  return jsonString
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027');
}

function jinjaTojson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return escapeJinjaString(JSON.stringify(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new UnboundedGlmRequestShape('a non-finite number in JSON');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jinjaTojson(item)).join(', ')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${escapeJinjaString(JSON.stringify(key))}: ${jinjaTojson(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  throw new UnboundedGlmRequestShape('a value Jinja tojson cannot represent');
}

/** The publisher template's `tool_to_json`: keys except defer_loading/strict. */
function toolToJson(tool: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(tool)) {
    if (key === 'defer_loading' || key === 'strict') continue;
    parts.push(`${JSON.stringify(key)}: ${jinjaTojson(value)}`);
  }
  return `{${parts.join(', ')}}`;
}

/** visible_text(): string content, or the concatenated text parts of a list. */
function visibleText(content: unknown, where: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (!isRecord(item)) throw new UnboundedGlmRequestShape(`${where} content item must be a mapping`);
      if (item.type === 'text') {
        if (typeof item.text !== 'string') {
          throw new UnboundedGlmRequestShape(`${where} text part carries no string text`);
        }
        out += item.text;
      } else {
        // image/video/audio (or anything else) is a modality this capability
        // does not bound — refuse rather than mis-count.
        throw new UnboundedGlmRequestShape(`${where} content part '${String(item.type)}' is not text-only`);
      }
    }
    return out;
  }
  throw new UnboundedGlmRequestShape(`${where} content must be a string or an array of parts`);
}

interface GlmProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly reasoning?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly argumentsObject: unknown }>;
  readonly toolCallId?: string;
}

/**
 * Stage 1 — the pinned @ai-sdk/openai-compatible 3.0.48 conversion, restricted
 * to the text-only local-function shape. Anything outside it REFUSES.
 */
function toProviderMessages(prompt: unknown): GlmProviderMessage[] {
  const out: GlmProviderMessage[] = [];
  for (const raw of asArray(prompt, 'prompt')) {
    if (!isRecord(raw)) throw new UnboundedGlmRequestShape('prompt entry must be a mapping');
    const role = raw.role;
    const content = raw.content;
    if (role === 'system') {
      if (typeof content !== 'string') {
        throw new UnboundedGlmRequestShape('system content must be a string');
      }
      out.push({ role: 'system', content });
      continue;
    }
    if (role === 'user') {
      out.push({ role: 'user', content: visibleText(content, 'user') });
      continue;
    }
    if (role === 'assistant') {
      let text = '';
      let reasoning: string | undefined;
      const toolCalls: { name: string; argumentsObject: unknown }[] = [];
      for (const part of asArray(content, 'assistant content')) {
        if (!isRecord(part)) throw new UnboundedGlmRequestShape('assistant part must be a mapping');
        if (part.type === 'text') {
          if (typeof part.text !== 'string') {
            throw new UnboundedGlmRequestShape('assistant text part carries no string text');
          }
          text += part.text;
        } else if (part.type === 'reasoning') {
          if (typeof part.text !== 'string') {
            throw new UnboundedGlmRequestShape('assistant reasoning part carries no string text');
          }
          reasoning = (reasoning ?? '') + part.text;
        } else if (part.type === 'tool-call') {
          if (typeof part.toolName !== 'string') {
            throw new UnboundedGlmRequestShape('assistant tool-call carries no toolName');
          }
          toolCalls.push({ name: part.toolName, argumentsObject: part.input });
        } else {
          throw new UnboundedGlmRequestShape(
            `assistant content part '${String(part.type)}' is not text/reasoning/tool-call`,
          );
        }
      }
      out.push({
        role: 'assistant',
        content: toolCalls.length > 0 ? (text !== '' ? text : null) : text,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (role === 'tool') {
      for (const result of asArray(content, 'tool content')) {
        if (!isRecord(result)) throw new UnboundedGlmRequestShape('tool result must be a mapping');
        if (typeof result.toolCallId !== 'string') {
          throw new UnboundedGlmRequestShape('tool result carries no toolCallId');
        }
        const output = result.output;
        if (!isRecord(output)) throw new UnboundedGlmRequestShape('tool result carries no output');
        const type = output.type;
        let value: string;
        if (type === 'text' || type === 'error-text') {
          if (typeof output.value !== 'string') {
            throw new UnboundedGlmRequestShape('tool text output value must be a string');
          }
          value = output.value;
        } else if (type === 'json' || type === 'error-json' || type === 'content') {
          value = jsonNoAscii(output.value);
        } else {
          throw new UnboundedGlmRequestShape(
            `tool output type '${String(type)}' is not a bounded text/json output`,
          );
        }
        out.push({ role: 'tool', content: value, toolCallId: result.toolCallId });
      }
      continue;
    }
    throw new UnboundedGlmRequestShape(`prompt role '${String(role)}' is not system/user/assistant/tool`);
  }
  return out;
}

/** The pinned local-function tool surface (hosted/provider tools refuse). */
interface GlmFunctionTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

function toFunctionTools(tools: unknown): GlmFunctionTool[] {
  if (tools === null || tools === undefined) return [];
  const out: GlmFunctionTool[] = [];
  for (const raw of asArray(tools, 'tools')) {
    if (!isRecord(raw)) throw new UnboundedGlmRequestShape('tool must be a mapping');
    if (raw.type !== 'function') {
      throw new UnboundedGlmRequestShape(
        `tool type '${String(raw.type)}' is not a local function tool (hosted/provider tools are refused)`,
      );
    }
    if (typeof raw.name !== 'string') throw new UnboundedGlmRequestShape('tool carries no name');
    if (raw.inputSchema === undefined) {
      throw new UnboundedGlmRequestShape('tool carries no inputSchema');
    }
    out.push({
      name: raw.name,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      inputSchema: raw.inputSchema,
    });
  }
  return out;
}

/** The pinned tool_choice shape. */
function renderToolChoice(toolChoice: unknown): string | undefined {
  if (toolChoice === null || toolChoice === undefined) return undefined;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return toolChoice;
    }
    throw new UnboundedGlmRequestShape(`tool_choice '${toolChoice}' is not auto/none/required`);
  }
  if (isRecord(toolChoice) && toolChoice.type === 'tool' && typeof toolChoice.toolName === 'string') {
    return `{"type": "function", "function": {"name": ${jinjaTojson(toolChoice.toolName)}}}`;
  }
  throw new UnboundedGlmRequestShape('tool_choice is not a bounded choice');
}

/** The ZAI provider-options subset; unknown/cap-changing keys refuse. */
function validateZaiOptions(providerOptions: unknown): {
  readonly reasoningEffort?: string;
  readonly doSample?: boolean;
  readonly thinking?: { readonly type?: 'enabled'; readonly clearThinking?: boolean };
  readonly toolStream?: boolean;
  readonly requestId?: string;
  readonly userId?: string;
} {
  if (providerOptions === null || providerOptions === undefined) return {};
  if (!isRecord(providerOptions)) throw new UnboundedGlmRequestShape('providerOptions must be a mapping');
  // Only the pinned `zai` namespace is understood; anything else is unknown.
  const zai = providerOptions.zai;
  if (providerOptions.zai === undefined) {
    const keys = Object.keys(providerOptions);
    if (keys.length > 0) {
      throw new UnboundedGlmRequestShape(`providerOptions namespace '${keys[0]}' is not 'zai'`);
    }
    return {};
  }
  if (!isRecord(zai)) throw new UnboundedGlmRequestShape('providerOptions.zai must be a mapping');
  for (const key of Object.keys(zai)) {
    if (!ZAI_OPTION_KEYS.has(key)) {
      throw new UnboundedGlmRequestShape(`providerOptions.zai.${key} is not a pinned option`);
    }
  }
  const result: {
    reasoningEffort?: string;
    doSample?: boolean;
    thinking?: { type?: 'enabled'; clearThinking?: boolean };
    toolStream?: boolean;
    requestId?: string;
    userId?: string;
  } = {};
  if (zai.doSample !== undefined) {
    if (typeof zai.doSample !== 'boolean') throw new UnboundedGlmRequestShape('doSample must be a boolean');
    result.doSample = zai.doSample;
  }
  if (zai.thinking !== undefined) {
    if (!isRecord(zai.thinking)) throw new UnboundedGlmRequestShape('thinking must be a mapping');
    const type = zai.thinking.type;
    if (type !== undefined && type !== 'enabled') {
      // GLM-5.3 thinking cannot be disabled and no other value is pinned.
      throw new UnboundedGlmRequestShape(
        `thinking.type '${String(type)}' is refused (GLM-5.3 thinking cannot be disabled)`,
      );
    }
    const clearThinking = zai.thinking.clearThinking;
    if (clearThinking !== undefined && typeof clearThinking !== 'boolean') {
      throw new UnboundedGlmRequestShape('thinking.clearThinking must be a boolean');
    }
    result.thinking = {
      ...(type === 'enabled' ? { type: 'enabled' as const } : {}),
      ...(clearThinking !== undefined ? { clearThinking } : {}),
    };
  }
  if (zai.reasoningEffort !== undefined) {
    const effort = zai.reasoningEffort;
    if (
      effort !== 'none' &&
      effort !== 'minimal' &&
      effort !== 'low' &&
      effort !== 'medium' &&
      effort !== 'high' &&
      effort !== 'xhigh' &&
      effort !== 'max'
    ) {
      throw new UnboundedGlmRequestShape(`reasoningEffort '${String(effort)}' is not pinned`);
    }
    result.reasoningEffort = effort;
  }
  if (zai.toolStream !== undefined) {
    if (typeof zai.toolStream !== 'boolean') throw new UnboundedGlmRequestShape('toolStream must be a boolean');
    result.toolStream = zai.toolStream;
  }
  if (zai.requestId !== undefined) {
    if (typeof zai.requestId !== 'string') throw new UnboundedGlmRequestShape('requestId must be a string');
    result.requestId = zai.requestId;
  }
  if (zai.userId !== undefined) {
    if (typeof zai.userId !== 'string') throw new UnboundedGlmRequestShape('userId must be a string');
    result.userId = zai.userId;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 — the ACTUAL publisher template skeleton (restricted branches)
// ---------------------------------------------------------------------------

const PREAMBLE = '[gMASK]<sop>';

/** The template's fixed `# Tools` prologue wrapper (literal text). */
function toolsPrologue(tools: readonly GlmFunctionTool[]): string {
  const header =
    '<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n' +
    'You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n';
  const rendered = tools.map((tool) => `${toolToJson(renderToolDict(tool))}\n`).join('');
  const footer =
    '</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n' +
    '<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value>' +
    '<arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>';
  return header + rendered + footer;
}

/** The provider tool dict the template renders after unwrapping `tool.function`. */
function renderToolDict(tool: GlmFunctionTool): Record<string, unknown> {
  // The template L40 unwraps `tool['function']` when present, then `tool_to_json`
  // drops `strict`/`defer_loading`; render the unwrapped dict EXACTLY.
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
  };
}

function renderAssistantToolCalls(
  toolCalls: ReadonlyArray<{ readonly name: string; readonly argumentsObject: unknown }>,
): string {
  let out = '';
  for (const call of toolCalls) {
    out += `<tool_call>${call.name}`;
    const args = call.argumentsObject;
    if (isRecord(args)) {
      for (const [key, value] of Object.entries(args)) {
        const rendered = typeof value === 'string' ? value : jinjaTojson(value);
        out += `<arg_key>${key}</arg_key><arg_value>${rendered}</arg_value>`;
      }
    }
    out += '</tool_call>';
  }
  return out;
}

/** The pinned BPE reasoning-effort capitalization; default `max` → `Max`. */
function capitalizeEffort(effort: string | undefined): string {
  const effective = effort === 'low' || effort === 'high' ? effort : 'max';
  return effective.charAt(0).toUpperCase() + effective.slice(1);
}

/**
 * Render the pinned publisher template for the RESTRICTED text-only shape.
 * Over-approximates only by INCLUDING whitespace/framing literal bytes (never
 * by omitting content); any branch it does not implement throws.
 */
function renderTemplate(
  messages: readonly GlmProviderMessage[],
  tools: readonly GlmFunctionTool[],
  reasoningEffort: string | undefined,
  clearThinking: boolean,
): string {
  let out = PREAMBLE;
  out += `<|system|>Reasoning Effort: ${capitalizeEffort(reasoningEffort)}`;
  if (tools.length > 0) out += `\n${toolsPrologue(tools)}`;
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if ((messages[i] as GlmProviderMessage).role === 'user') lastUserIndex = i;
  }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as GlmProviderMessage;
    if (message.role === 'system') {
      out += `<|system|>${visibleText(message.content ?? '', 'system')}`;
      continue;
    }
    if (message.role === 'user') {
      out += `<|user|>${visibleText(message.content ?? '', 'user')}`;
      continue;
    }
    if (message.role === 'assistant') {
      out += '<|assistant|>';
      // Template L145-147: reasoning may be an explicit field OR embedded in the
      // assistant content as a `<think>…</think>` prefix.
      let content = typeof message.content === 'string' ? message.content : '';
      let reasoning = message.reasoning;
      if (reasoning === undefined && content.includes('</think>')) {
        const before = content.split('</think>')[0] ?? '';
        const thinkOpen = before.split('<think>');
        reasoning = thinkOpen[thinkOpen.length - 1] ?? '';
        content = content.split('</think>').slice(1).join('</think>');
      }
      // Template L148-152: emit the reasoning only when thinking is not cleared
      // for history, else an empty think block.
      out +=
        (!clearThinking || i > lastUserIndex) && reasoning !== undefined
          ? `<think>${reasoning}</think>`
          : '<think></think>';
      const text = content.trim();
      if (text !== '') out += text;
      if (message.toolCalls !== undefined) out += renderAssistantToolCalls(message.toolCalls);
      continue;
    }
    // role === 'tool'
    const previous = i > 0 ? (messages[i - 1] as GlmProviderMessage) : undefined;
    if (previous === undefined || previous.role !== 'tool') out += '<|observation|>';
    out += `<tool_response>${visibleText(message.content ?? '', 'tool')}</tool_response>`;
  }
  out += '<|assistant|><think>';
  return out;
}

/**
 * The projection's own output-cap field must be a safe positive integer (the
 * capability's `withOutputCeiling` sets it). Anything else refuses.
 */
function validateMaxOutputTokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new UnboundedGlmRequestShape('maxOutputTokens must be a safe positive integer');
  }
  return value as number;
}

/** The parsed countable projection, fully validated. */
interface GlmProjectionFacts {
  readonly messages: readonly GlmProviderMessage[];
  readonly tools: readonly GlmFunctionTool[];
  readonly reasoningEffort: string | undefined;
  readonly clearThinking: boolean;
  readonly responseFormatBytes: number;
}

function parseProjection(input: unknown, attestation: GlmHostedTransformAttestation | undefined): GlmProjectionFacts {
  if (!isRecord(input)) throw new UnboundedGlmRequestShape('projection must be a JSON object');
  const messages = toProviderMessages(input.prompt);
  const tools = toFunctionTools(input.tools);
  validateMaxOutputTokens(input.maxOutputTokens);
  const options = validateZaiOptions(input.providerOptions);
  const toolChoice = input.toolChoice;
  // tool_choice is accepted but not part of the rendered prompt bound (it is an
  // HTTP field). It still must be a bounded shape.
  renderToolChoice(toolChoice);
  // Sampling knobs are HTTP fields, not prompt text; a bounded value is fine.
  for (const key of ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'reasoning']) {
    const value = input[key];
    if (value !== null && value !== undefined && typeof value !== 'number' && typeof value !== 'string') {
      throw new UnboundedGlmRequestShape(`${key} carries an unbounded value`);
    }
  }
  if (input.stopSequences !== null && input.stopSequences !== undefined) {
    asArray(input.stopSequences, 'stopSequences');
  }
  // response_format is NOT rendered by the publisher chat template. Refuse any
  // non-null response format unless the host attestation supplies a COMPLETE
  // known transform; the HTTP field is never silently dropped from the bound.
  let responseFormatBytes = 0;
  if (input.responseFormat !== null && input.responseFormat !== undefined) {
    if (attestation?.responseFormatTransform === undefined) {
      throw new UnboundedGlmRequestShape(
        'responseFormat is set but the publisher template renders no schema instruction and no hosted transform is attested',
      );
    }
    responseFormatBytes = attestation.responseFormatTransform.renderInstructionBytes(
      jinjaTojson(input.responseFormat),
    );
    if (!Number.isSafeInteger(responseFormatBytes) || responseFormatBytes < 0) {
      throw new UnboundedGlmRequestShape('the attested responseFormat transform returned an unsafe byte count');
    }
  }
  return { messages, tools, reasoningEffort: options.reasoningEffort, clearThinking: options.thinking?.clearThinking === true, responseFormatBytes };
}

/** The exported render primitive: the exact rendered prompt string. */
export function renderGlmTextPrompt(projection: unknown, attestation?: GlmHostedTransformAttestation): string {
  const facts = parseProjection(projection, attestation);
  return renderTemplate(facts.messages, facts.tools, facts.reasoningEffort, facts.clearThinking);
}

/**
 * The exported shared-vector primitive: the PROVEN input-token upper bound for
 * the exact projection, or a refusal. Safe integer, never negative.
 */
export function countGlmTextPromptBytes(projection: unknown, attestation?: GlmHostedTransformAttestation): number {
  const facts = parseProjection(projection, attestation);
  const rendered = renderTemplate(facts.messages, facts.tools, facts.reasoningEffort, facts.clearThinking);
  const total = utf8Bytes(rendered) + facts.responseFormatBytes;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_SAFE) {
    throw new UnboundedGlmRequestShape('the rendered bound exceeds the safe integer range');
  }
  return total;
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

function attestationMatches(
  input: GlmCapabilityInput,
  attestation: GlmHostedTransformAttestation,
): boolean {
  return (
    input.provider === GLM_TEXT_PROFILE.provider &&
    input.model === GLM_TEXT_PROFILE.model &&
    input.endpoint === GLM_TEXT_PROFILE.endpoint &&
    attestation.provider === GLM_TEXT_PROFILE.provider &&
    attestation.model === GLM_TEXT_PROFILE.model &&
    attestation.endpoint === GLM_TEXT_PROFILE.endpoint &&
    typeof attestation.hostedBuild === 'string' &&
    attestation.hostedBuild.length > 0 &&
    attestation.templateRevision === GLM_TEXT_PROFILE.publisherTemplate.revision &&
    attestation.tokenizerRevision === GLM_TEXT_PROFILE.publisherTokenizerRevision &&
    attestation.reasoningInclusiveMaxTokens === true &&
    attestation.noUnreservedHiddenGeneration === true
  );
}

/**
 * Build the GLM-5.3-flash text-only capability. SYNCHRONOUS and PURE — no I/O,
 * no network, no await (it deliberately runs before `resolveModel`). Returns
 * `undefined` (capability ABSENT) unless the exact profile is selected AND a
 * matching trusted-host attestation is supplied. Never enabled by a model name,
 * string or boolean.
 */
export function createGlmTextCapability(
  input: GlmCapabilityInput,
  attestation: GlmHostedTransformAttestation | undefined,
): StrictTokenCapability | undefined {
  if (attestation === undefined) return undefined;
  if (!attestationMatches(input, attestation)) return undefined;
  const bound = attestation;
  return {
    provenance: `${bound.provenance} (glm-5.3-flash text-only; profile ${GLM_TEXT_PROFILE.packages.zai.version}/${GLM_TEXT_PROFILE.packages.openAiCompatible.version})`,
    count(serialized: string): number {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized) as unknown;
      } catch {
        throw new UnboundedGlmRequestShape('the projection is not parseable JSON');
      }
      return countGlmTextPromptBytes(parsed, bound);
    },
    withOutputCeiling(
      params: LanguageModelV4CallOptions,
      reserveOutputTokens: number,
    ): LanguageModelV4CallOptions {
      if (!Number.isSafeInteger(reserveOutputTokens) || reserveOutputTokens < 1) {
        throw new UnboundedGlmRequestShape('reserveOutputTokens must be a safe positive integer');
      }
      // A request-provided cap-changing provider option would defeat the
      // reserve; the pinned ZAI option set has none, but be explicit.
      if (params.maxOutputTokens !== undefined && params.maxOutputTokens > reserveOutputTokens) {
        throw new UnboundedGlmRequestShape('the request output ceiling exceeds the reserve');
      }
      return Object.freeze({ ...params, maxOutputTokens: reserveOutputTokens });
    },
  };
}
