// Adversarial offline tests for the GLM-5.3-flash text-only capability
// (src/driver/ai-sdk/glm-capability.ts). No network, no provider, no keys.
//
// The shared shape vectors in test/fixtures/glm-shape-vectors.json are the
// cross-language contract: the Python mirror computes the SAME rendered bound
// over the SAME projections. NO hard-coded byte counts are asserted (a numeric
// proof that was never executed would be fabricated) — the assertions are
// structural (exact literal inclusion, refusal, monotonicity) plus the exact
// rendered string this renderer produces.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  countGlmTextPromptBytes,
  createGlmTextCapability,
  GLM_TEXT_PROFILE,
  renderGlmTextPrompt,
  UnboundedGlmRequestShape,
} from '../../src/driver/ai-sdk/glm-capability.js';
import type { GlmHostedTransformAttestation } from '../../src/driver/ai-sdk/glm-capability.js';

interface AcceptVector {
  name: string;
  projection: unknown;
  mustContain: readonly string[];
  mustNotContain: readonly string[];
}
interface RefuseVector {
  name: string;
  projection: unknown;
}
interface MonotonicVector {
  name: string;
  smaller: unknown;
  larger: unknown;
}
interface Vectors {
  profile: { provider: string; model: string; endpoint: string };
  accept: readonly AcceptVector[];
  refuse: readonly RefuseVector[];
  monotonic: readonly MonotonicVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/glm-shape-vectors.json', import.meta.url), 'utf8'),
) as Vectors;

const ATTESTATION: GlmHostedTransformAttestation = {
  provider: 'zai',
  model: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/coding/paas/v4',
  hostedBuild: 'test-hosted-build',
  templateRevision: '91b69215804f2d2036a8867f6ce44848e278dcda',
  tokenizerRevision: '91b69215804f2d2036a8867f6ce44848e278dcda',
  reasoningInclusiveMaxTokens: true,
  noUnreservedHiddenGeneration: true,
  provenance: 'test:glm-text',
};

const INPUT = {
  provider: GLM_TEXT_PROFILE.provider,
  model: GLM_TEXT_PROFILE.model,
  endpoint: GLM_TEXT_PROFILE.endpoint,
};

describe('glm text capability — fail-closed by default', () => {
  test('no attestation => capability ABSENT (undefined), never name/boolean enabled', () => {
    expect(createGlmTextCapability(INPUT, undefined)).toBeUndefined();
  });

  test('a mismatching attestation (wrong build/route) => ABSENT', () => {
    expect(
      createGlmTextCapability(INPUT, { ...ATTESTATION, hostedBuild: '' }),
    ).toBeUndefined();
    expect(
      createGlmTextCapability(INPUT, { ...ATTESTATION, model: 'glm-4.5' }),
    ).toBeUndefined();
    expect(
      createGlmTextCapability(
        { ...INPUT, endpoint: 'https://api.z.ai/api/paas/v4' },
        ATTESTATION,
      ),
    ).toBeUndefined();
  });

  test('an exact matching attestation => capability present, synchronous pure', () => {
    const capability = createGlmTextCapability(INPUT, ATTESTATION);
    expect(capability).toBeDefined();
    // PURE + sync: constructing it performed no I/O and returned synchronously.
    expect(typeof capability?.count).toBe('function');
    expect(typeof capability?.withOutputCeiling).toBe('function');
  });
});

describe('glm text capability — count is a proven render bound (no multiplier)', () => {
  for (const vector of vectors.accept) {
    test(`accept: ${vector.name}`, () => {
      const rendered = renderGlmTextPrompt(vector.projection, ATTESTATION);
      for (const literal of vector.mustContain) {
        expect(rendered).toContain(literal);
      }
      for (const forbidden of vector.mustNotContain) {
        expect(rendered).not.toContain(forbidden);
      }
      const capability = createGlmTextCapability(INPUT, ATTESTATION);
      if (capability === undefined) throw new Error('expected the capability to be present');
      const counted = capability.count(JSON.stringify(vector.projection));
      expect(counted).toBe(Buffer.byteLength(rendered, 'utf8'));
      expect(Number.isSafeInteger(counted)).toBe(true);
    });
  }

  test('count is EXACTLY the rendered UTF-8 byte length (no padding/multiplier)', () => {
    const projection = vectors.accept[0]?.projection;
    const rendered = renderGlmTextPrompt(projection, ATTESTATION);
    expect(countGlmTextPromptBytes(projection, ATTESTATION)).toBe(
      Buffer.byteLength(rendered, 'utf8'),
    );
  });

  for (const vector of vectors.monotonic) {
    test(`monotonic: ${vector.name}`, () => {
      const smaller = countGlmTextPromptBytes(vector.smaller, ATTESTATION);
      const larger = countGlmTextPromptBytes(vector.larger, ATTESTATION);
      expect(larger).toBeGreaterThan(smaller);
    });
  }

  test('astral characters cost their UTF-8 bytes (astral is not 1 byte)', () => {
    const astral = vectors.accept.find((v) => v.name.includes('astral'));
    if (astral === undefined) throw new Error('astral vector missing');
    const rendered = renderGlmTextPrompt(astral.projection, ATTESTATION);
    // The 4-byte emoji survives the render and is counted as UTF-8.
    expect(rendered).toContain('😀');
    expect(countGlmTextPromptBytes(astral.projection, ATTESTATION)).toBe(
      Buffer.byteLength(rendered, 'utf8'),
    );
  });
});

describe('glm text capability — refuse unbounded shapes', () => {
  for (const vector of vectors.refuse) {
    test(`refuse: ${vector.name}`, () => {
      expect(() => countGlmTextPromptBytes(vector.projection, ATTESTATION)).toThrow(
        UnboundedGlmRequestShape,
      );
      const capability = createGlmTextCapability(INPUT, ATTESTATION);
      if (capability === undefined) throw new Error('expected the capability to be present');
      expect(() => capability.count(JSON.stringify(vector.projection))).toThrow(
        UnboundedGlmRequestShape,
      );
    });
  }

  test('thinking.type disabled is refused even though the provider accepts it', () => {
    const projection = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: null,
      toolChoice: null,
      responseFormat: null,
      providerOptions: { zai: { thinking: { type: 'disabled' } } },
      maxOutputTokens: 64,
    };
    expect(() => countGlmTextPromptBytes(projection, ATTESTATION)).toThrow(
      UnboundedGlmRequestShape,
    );
  });

  test('a non-parseable projection refuses', () => {
    const capability = createGlmTextCapability(INPUT, ATTESTATION);
    if (capability === undefined) throw new Error('expected the capability to be present');
    expect(() => capability.count('{not json')).toThrow(UnboundedGlmRequestShape);
  });
});

describe('glm text capability — withOutputCeiling', () => {
  test('sets maxOutputTokens to the reserve and freezes the returned params', () => {
    const capability = createGlmTextCapability(INPUT, ATTESTATION);
    if (capability === undefined) throw new Error('expected the capability to be present');
    const prepared = capability.withOutputCeiling(
      { prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] },
      64,
    );
    expect(prepared.maxOutputTokens).toBe(64);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  test('refuses a non-safe/non-positive reserve and an over-reserve request cap', () => {
    const capability = createGlmTextCapability(INPUT, ATTESTATION);
    if (capability === undefined) throw new Error('expected the capability to be present');
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        capability.withOutputCeiling(
          { prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] },
          bad,
        ),
      ).toThrow(UnboundedGlmRequestShape);
    }
    expect(() =>
      capability.withOutputCeiling(
        { prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], maxOutputTokens: 128 },
        64,
      ),
    ).toThrow(UnboundedGlmRequestShape);
  });
});
