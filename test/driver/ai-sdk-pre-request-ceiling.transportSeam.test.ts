// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the SDK transport-seam subject (§3).
import { describe, expect, test } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  PreRequestCeiling,
  isPreRequestCeilingRefusal,
  wrapWithPreRequestCeiling,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  fakeCapability,
  retryableApiError,
  textResult,
} from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 3. The SDK transport seam — the retry re-enters the wrapper (verified claim)
// ---------------------------------------------------------------------------

describe('pre-request ceiling on the SDK transport seam', () => {
  test('one SDK retry re-enters the middleware: requestCount === 2, no duplicate retry', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) throw retryableApiError();
        return textResult('ok');
      },
    });
    const result = await generateText({
      model: wrapWithPreRequestCeiling(mock, ceiling),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
    });
    expect(result.text).toBe('ok');
    expect(calls).toBe(2); // the SDK retried once...
    expect(ceiling.requestCount).toBe(2); // ...and the retry re-entered the ceiling
    expect(ceiling.reservedTokens).toBeGreaterThan(0);
  });

  test('without a retry the ceiling counts exactly one attempt', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('ok');
      },
    });
    await generateText({
      model: wrapWithPreRequestCeiling(mock, ceiling),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
    });
    expect(calls).toBe(1);
    expect(ceiling.requestCount).toBe(1);
  });

  test('a refusal is not retried and the model is never called', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 4, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('ok');
      },
    });
    try {
      await generateText({
        model: wrapWithPreRequestCeiling(mock, ceiling),
        messages: [{ role: 'user', content: 'this request is far over the tiny ceiling' }],
        maxRetries: 1,
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isPreRequestCeilingRefusal(err)).toBe(true);
    }
    expect(calls).toBe(0);
    expect(ceiling.requestCount).toBe(0);
  });
});
