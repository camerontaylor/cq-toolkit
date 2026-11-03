// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures, this file) and
// seven subject files; this module carries the fixtures only — no tests, no
// describe.
//
// The ai-sdk lane's STRICT pre-request token ceiling (pre-request-ceiling.ts)
// — focused unit + driver tests with a fake model and an INJECTED capability.
// No provider, no network. The driver ships NO built-in capability, so these
// tests supply one explicitly; the "no injection => refuse" legs pin that.
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { PreRequestCeilingRefusal } from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type {
  PreRequestCeilingRefusalReason,
  StrictTokenCapability,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type { OpInvocation } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trusted test capability: utf8 byte count + applies maxOutputTokens. */
export function fakeCapability(
  overrides: Partial<StrictTokenCapability> = {},
): StrictTokenCapability {
  return {
    provenance: 'test:utf8-byte-count',
    count: (serialized) => Buffer.byteLength(serialized, 'utf8'),
    withOutputCeiling: (params, reserveOutputTokens) => ({
      ...params,
      maxOutputTokens: reserveOutputTokens,
    }),
    ...overrides,
  };
}

export function userPrompt(text: string) {
  return { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] };
}

/** The mutable text part of a probe prompt (index-safe for the mutation tests). */
export function firstTextPart(params: { prompt: unknown }): { text: string } {
  const prompt = params.prompt as Array<{ content: Array<{ text?: string }> }>;
  const part = prompt[0]?.content[0];
  if (part === undefined || typeof part.text !== 'string') {
    throw new Error('probe prompt has no text part');
  }
  return part as { text: string };
}

/**
 * A deliberately JSON-INVALID providerOptions payload for the fail-closed
 * legs only (a cycle, a bigint, a function). The RUNTIME guard — the
 * fail-closed serializer or structuredClone — is what must reject it; this
 * narrow, test-only assertion is how a JSON-invalid value reaches that guard.
 * Never used for a fixture that is expected to serialize.
 */
export function invalidProviderOptions(
  value: unknown,
): NonNullable<LanguageModelV4CallOptions['providerOptions']> {
  return value as NonNullable<LanguageModelV4CallOptions['providerOptions']>;
}

function mockUsage(): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  };
}

export function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/** A retryable provider error (the SDK's own retryable class). */
export function retryableApiError(): APICallError {
  return new APICallError({
    message: 'endpoint hiccup',
    url: 'https://example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
}

export function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'strict ceiling run',
    modelSpec: { provider: 'anthropic', model: 'claude-test' },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget: {},
    ...overrides,
  };
}

export async function refusalFrom(fn: () => Promise<unknown>): Promise<PreRequestCeilingRefusal> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PreRequestCeilingRefusal) return err;
    throw err;
  }
  throw new Error('expected a PreRequestCeilingRefusal');
}

export function reasonOfRefusal(err: PreRequestCeilingRefusal): PreRequestCeilingRefusalReason {
  return err.reason;
}
