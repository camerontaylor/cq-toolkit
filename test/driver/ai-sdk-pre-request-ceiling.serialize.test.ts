// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the serialization subject (§1).
import { describe, expect, test } from 'vitest';
import {
  serializeRequestForCounting,
  UnrepresentableRequestError,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import { invalidProviderOptions } from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 1. Serialization — complete params, deterministic, fail closed
// ---------------------------------------------------------------------------

describe('serializeRequestForCounting', () => {
  test('carries prompt, tools, response format, providerOptions, and token-relevant settings', () => {
    const serialized = serializeRequestForCounting({
      prompt: [
        { role: 'system', content: 'SYSTEM-MARKER' },
        { role: 'user', content: [{ type: 'text', text: 'USER-MARKER' }] },
      ],
      tools: [
        { type: 'function', name: 'TOOL-MARKER', inputSchema: { type: 'object', properties: {} } },
      ],
      toolChoice: { type: 'tool', toolName: 'TOOL-MARKER' },
      responseFormat: { type: 'json', name: 'RESPONSE-MARKER' },
      providerOptions: { anthropic: { instructions: 'PROVIDER-OPTIONS-MARKER' } },
      reasoning: 'high',
      stopSequences: ['STOP-MARKER'],
    });
    for (const marker of [
      'SYSTEM-MARKER',
      'USER-MARKER',
      'TOOL-MARKER',
      'RESPONSE-MARKER',
      'PROVIDER-OPTIONS-MARKER',
      '"reasoning":"high"',
      'STOP-MARKER',
    ]) {
      expect(serialized).toContain(marker);
    }
  });

  test('never serializes credential headers', () => {
    const serialized = serializeRequestForCounting({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      headers: { authorization: 'Bearer SUPER-SECRET', 'x-api-key': 'SECRET-KEY' },
    });
    expect(serialized).not.toContain('SUPER-SECRET');
    expect(serialized).not.toContain('SECRET-KEY');
  });

  test('fails closed on a cyclic providerOptions shape', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: cyclic }),
      }),
    ).toThrow(UnrepresentableRequestError);
  });

  test('fails closed on a bigint or function in providerOptions', () => {
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { n: 1n } }),
      }),
    ).toThrow(UnrepresentableRequestError);
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { fn: () => 1 } }),
      }),
    ).toThrow(UnrepresentableRequestError);
  });
});
