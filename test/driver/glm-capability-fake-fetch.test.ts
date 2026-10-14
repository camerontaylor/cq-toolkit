// Fake-fetch serializer/output-ceiling proof for the GLM-5.3-flash capability
// (C2). OFFLINE and fake-only: a custom `fetch` on the real pinned
// `createZai` model captures the exact outbound HTTP body; no network, no
// provider, no key (a literal fake key). The middleware under test is the #318
// `wrapWithPreRequestCeiling`; the capability is our text-only GLM capability.
//
// Proves: (a) `max_tokens` reaches the wire equal to the reserved output on
// every attempt INCLUDING an SDK retry and a two-step TOOL loop (the middleware
// re-enters per step); (b) the wire `messages` match the PINNED serializer's
// expectation (not a renderer-own self-check); (c) a structured/repair-shaped
// request REFUSES before any wire contact (the publisher template renders no
// schema instruction) — a NAMED activation blocker for strict structured jobs.
import { describe, expect, test } from 'vitest';
import { generateText, jsonSchema, Output, stepCountIs, tool } from 'ai';
import { createZai } from '@ai-sdk/zai';
import {
  PreRequestCeiling,
  wrapWithPreRequestCeiling,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  createGlmTextCapability,
  GLM_TEXT_PROFILE,
} from '../../src/driver/ai-sdk/glm-capability.js';
import type { GlmHostedTransformAttestation } from '../../src/driver/ai-sdk/glm-capability.js';

const ATTESTATION: GlmHostedTransformAttestation = {
  provider: 'zai',
  model: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/coding/paas/v4',
  hostedBuild: 'fake-fetch-test-build',
  templateRevision: '91b69215804f2d2036a8867f6ce44848e278dcda',
  tokenizerRevision: '91b69215804f2d2036a8867f6ce44848e278dcda',
  reasoningInclusiveMaxTokens: true,
  noUnreservedHiddenGeneration: true,
  provenance: 'test:glm-fake-fetch',
};

const INPUT = {
  provider: GLM_TEXT_PROFILE.provider,
  model: GLM_TEXT_PROFILE.model,
  endpoint: GLM_TEXT_PROFILE.endpoint,
};

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A scripted fake fetch: captures each request and returns the next response. */
function fakeFetch(script: readonly (() => Response)[]): {
  fetch: typeof globalThis.fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  let call = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    captured.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    if (step === undefined) throw new Error('fake fetch ran out of scripted responses');
    return step();
  };
  return { fetch: fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successText(text: string): Response {
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: GLM_TEXT_PROFILE.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function retryableFailure(): Response {
  return jsonResponse({ error: { message: 'endpoint hiccup', code: 'overloaded' } }, 503);
}

function toolCallResponse(id: string, name: string, args: unknown): Response {
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: GLM_TEXT_PROFILE.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function ceiling(): PreRequestCeiling {
  return new PreRequestCeiling({
    budget: { maxInputTokens: 100_000, reserveOutputTokens: 64 },
    capability: (() => {
      const capability = createGlmTextCapability(INPUT, ATTESTATION);
      if (capability === undefined) throw new Error('expected the capability to be present');
      return capability;
    })(),
    modelSpec: { provider: GLM_TEXT_PROFILE.provider, model: GLM_TEXT_PROFILE.model },
  });
}

describe('glm capability — fake-fetch output-ceiling proof', () => {
  test('max_tokens reaches the wire as the reserve on a plain completion', async () => {
    const { fetch, captured } = fakeFetch([() => successText('ok')]);
    const model = wrapWithPreRequestCeiling(
      createZai({ apiKey: 'fake-key', baseURL: GLM_TEXT_PROFILE.endpoint, fetch }).languageModel(
        GLM_TEXT_PROFILE.model,
      ),
      ceiling(),
    );
    const result = await generateText({
      model,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(result.text).toBe('ok');
    expect(captured).toHaveLength(1);
    const body = captured[0]?.body;
    // Exactly the pinned provider field, exactly the reserve.
    expect(body?.max_tokens).toBe(64);
    expect(body?.model).toBe(GLM_TEXT_PROFILE.model);
    // The request path is the pinned chat route.
    expect(captured[0]?.url).toContain('/chat/completions');
  });

  test('an SDK retry re-enters the middleware: max_tokens is reserved on EVERY attempt', async () => {
    const { fetch, captured } = fakeFetch([
      () => retryableFailure(),
      () => successText('recovered'),
    ]);
    const model = wrapWithPreRequestCeiling(
      createZai({ apiKey: 'fake-key', baseURL: GLM_TEXT_PROFILE.endpoint, fetch }).languageModel(
        GLM_TEXT_PROFILE.model,
      ),
      ceiling(),
    );
    const result = await generateText({
      model,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxRetries: 1,
    });
    expect(result.text).toBe('recovered');
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const request of captured) {
      expect(request.body.max_tokens).toBe(64);
    }
  });

  test('the wire messages equal our stage-1 transform for the same prompt (hard equality)', async () => {
    const { fetch, captured } = fakeFetch([() => successText('ok')]);
    const model = wrapWithPreRequestCeiling(
      createZai({ apiKey: 'fake-key', baseURL: GLM_TEXT_PROFILE.endpoint, fetch }).languageModel(
        GLM_TEXT_PROFILE.model,
      ),
      ceiling(),
    );
    await generateText({
      model,
      // ai@7 forbids a `system` role inside the `prompt` array; use the
      // supported `instructions` option, which still serializes as a system
      // message on the wire.
      instructions: 'sys',
      prompt: 'ask',
    });
    const body = captured[0]?.body as { messages?: unknown };
    // PINNED-SERIALIZER EXPECTATION (not a renderer-own stage-1 self-check): the
    // pinned @ai-sdk/openai-compatible serializer folds a single text part to a
    // plain string and keeps a system message as a string. This asserts the
    // WIRE matches that pinned expectation.
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ask' },
    ]);
  });

  test('a tool STEP reserves max_tokens on every step (two-step tool loop)', async () => {
    const { fetch, captured } = fakeFetch([
      () => toolCallResponse('call-1', 'lookup', { q: 'x' }),
      () => successText('done'),
    ]);
    const model = wrapWithPreRequestCeiling(
      createZai({ apiKey: 'fake-key', baseURL: GLM_TEXT_PROFILE.endpoint, fetch }).languageModel(
        GLM_TEXT_PROFILE.model,
      ),
      ceiling(),
    );
    const result = await generateText({
      model,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'look' }] }],
      tools: {
        lookup: tool({
          description: 'lookup',
          inputSchema: jsonSchema({
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          }),
          execute: async () => ({ ok: true }),
        }),
      },
      stopWhen: stepCountIs(2),
    });
    expect(result.text).toBe('done');
    // The ceiling sees the NORMALIZED params.tools array and reserves on the
    // tool step AND the follow-up step; max_tokens reaches the wire on both.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const request of captured) {
      expect(request.body.max_tokens).toBe(64);
    }
  });

  test('a structured/repair-shaped request REFUSES before the fetch (named activation blocker)', async () => {
    const { fetch, captured } = fakeFetch([() => successText('never sent')]);
    const model = wrapWithPreRequestCeiling(
      createZai({ apiKey: 'fake-key', baseURL: GLM_TEXT_PROFILE.endpoint, fetch }).languageModel(
        GLM_TEXT_PROFILE.model,
      ),
      ceiling(),
    );
    let thrown: unknown;
    try {
      await generateText({
        model,
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'structured' }] }],
        // Output.object sets a responseFormat, which the publisher template does
        // not render and this capability therefore REFUSES.
        output: Output.object({
          schema: jsonSchema({ type: 'object', properties: { a: { type: 'string' } } }),
        }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Refused BEFORE any wire contact: NO metered structured/repair send occurs.
    expect(captured).toHaveLength(0);
  });
});
