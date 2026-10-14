// The canonical cross-language request-projection protocol v1
// (src/driver/ai-sdk/canonical-projection.ts) — focused unit tests. No provider,
// no network, no child process: a pure encoder plus the shared byte+digest
// vectors.
//
// SCOPE OF EVIDENCE: these tests exercise the TypeScript encoder against vectors
// that the SAME TypeScript implementation produced. They do NOT, by themselves,
// prove cross-language equality. The Python reproduction test
// (test_canonical_projection.py) does reproduce these exact vectors — it ran OK
// over the CRQ union a13c6e4c under an independent runner — but the TypeScript
// side is NOT executed in this lane (execution is centralized on Neptune) and the
// pair has no independent review of THIS head, so no interoperability is claimed
// here.
import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import {
  buildCountedProjection,
  canonicalProjectionBytes,
  canonicalProjectionBytesHex,
  canonicalProjectionDigest,
  canonicalProjectionDigestOf,
  CanonicalProjectionUnrepresentableError,
  CANONICAL_PROJECTION_DOMAIN,
  CANONICAL_PROJECTION_MAGIC,
  CANONICAL_PROJECTION_PROTOCOL,
  CANONICAL_PROJECTION_VERSION,
  COUNTED_PROJECTION_FIELDS,
  hasLoneSurrogate,
} from '../../src/driver/ai-sdk/canonical-projection.js';
import {
  CANONICAL_PROJECTION_POSITIVE_VECTORS,
  CANONICAL_PROJECTION_REFUSALS,
  CANONICAL_PROJECTION_VECTOR_PROTOCOL,
} from './canonical-projection-vectors.js';
import type { CanonicalVectorValue } from './canonical-projection-vectors.js';

/**
 * Decode a language-neutral vector descriptor into a JS value. Mirrors the
 * Python helper in test_canonical_projection.py one case at a time.
 */
function decodeVector(value: CanonicalVectorValue): unknown {
  switch (value.t) {
    case 'null':
      return null;
    case 'bool':
      return value.v;
    case 'int':
      return Number(value.v);
    case 'float':
      return Number(value.v);
    case 'str':
      return value.v;
    case 'arr':
      return value.v.map(decodeVector);
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.v) out[key] = decodeVector(item);
      return out;
    }
    case 'cycle': {
      const node: Record<string, unknown> = {};
      node.self = node;
      return node;
    }
    case 'mapint': {
      const map = new Map<number, string>();
      map.set(1, 'x');
      return map;
    }
    case 'set':
      return new Set([1]);
    case 'bytes':
      return Buffer.from([0]);
    case 'nonfinite':
      return Number.NaN;
    default:
      throw new Error(`unknown vector descriptor ${JSON.stringify(value)}`);
  }
}

/**
 * A deliberately JSON-INVALID providerOptions payload for the negative legs
 * only. The narrow, test-only assertion is how an invalid value reaches the
 * runtime guard; it is never used for a fixture expected to serialize.
 */
function invalidProviderOptions(
  value: unknown,
): NonNullable<LanguageModelV4CallOptions['providerOptions']> {
  return value as NonNullable<LanguageModelV4CallOptions['providerOptions']>;
}

describe('canonical projection protocol constants', () => {
  test('the module constants agree with the shared vector header', () => {
    expect(CANONICAL_PROJECTION_MAGIC).toBe(CANONICAL_PROJECTION_VECTOR_PROTOCOL.magic);
    expect(CANONICAL_PROJECTION_VERSION).toBe(CANONICAL_PROJECTION_VECTOR_PROTOCOL.version);
    expect(CANONICAL_PROJECTION_DOMAIN).toBe(CANONICAL_PROJECTION_VECTOR_PROTOCOL.domain);
    expect(CANONICAL_PROJECTION_PROTOCOL).toBe('crq/request-projection/v1');
    expect(COUNTED_PROJECTION_FIELDS).toHaveLength(14);
    // The protocol is explicitly NOT JCS and owns its magic + version.
    expect(CANONICAL_PROJECTION_MAGIC).toBe('CRQP');
    expect(CANONICAL_PROJECTION_VERSION).toBe(1);
  });
});

describe('shared byte+digest vectors', () => {
  test.each(CANONICAL_PROJECTION_POSITIVE_VECTORS)(
    '$name encodes to the recorded bytes',
    (vector) => {
      const bytes = canonicalProjectionBytes(decodeVector(vector.value));
      expect(bytes.toString('hex')).toBe(vector.bytesHex);
      expect(canonicalProjectionDigestOf(bytes)).toBe(vector.sha256);
      expect(canonicalProjectionDigest(decodeVector(vector.value))).toBe(vector.sha256);
    },
  );

  test.each(CANONICAL_PROJECTION_REFUSALS)('$name is refused by the encoder', (vector) => {
    expect(() => canonicalProjectionBytes(decodeVector(vector.value))).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('0 and 0.0 encode identically (value-based number rule)', () => {
    expect(canonicalProjectionBytesHex(0)).toBe(canonicalProjectionBytesHex(0.0));
  });

  test('negative zero is distinct from integer zero', () => {
    expect(canonicalProjectionBytesHex(-0)).not.toBe(canonicalProjectionBytesHex(0));
    // 0x8000000000000000 is the -0 double bit pattern, tag 0x04.
    expect(canonicalProjectionBytesHex(-0).endsWith('8000000000000000')).toBe(true);
  });

  test('map keys sort by UTF-8 bytes, not the JS default UTF-16 order', () => {
    const utf16Order = ['\u{10000}', '\uFFFD'].sort();
    expect(utf16Order[0]).toBe('\u{10000}');
    const hex = canonicalProjectionBytesHex({ '\u{10000}': 1, '\uFFFD': 2 });
    const replacement = Buffer.from('\uFFFD', 'utf8').toString('hex');
    const supplementary = Buffer.from('\u{10000}', 'utf8').toString('hex');
    const atReplacement = hex.indexOf(replacement);
    const atSupplementary = hex.indexOf(supplementary);
    expect(atReplacement).toBeGreaterThan(-1);
    expect(atSupplementary).toBeGreaterThan(-1);
    expect(atReplacement).toBeLessThan(atSupplementary);
  });

  test('an undefined value encodes as null (the projection builder never emits undefined)', () => {
    expect(canonicalProjectionBytesHex({ a: undefined })).toBe(
      canonicalProjectionBytesHex({ a: null }),
    );
  });

  test('the canonical digest is not the old JSON.stringify digest', () => {
    const projection = buildCountedProjection({ prompt: 'hello', maxOutputTokens: 8 });
    const oldLocal = Buffer.from(JSON.stringify(projection), 'utf8');
    expect(canonicalProjectionBytesHex(projection)).not.toBe(oldLocal.toString('hex'));
  });
});

describe('counted projection shape', () => {
  test('buildCountedProjection carries exactly the shared counted fields, missing as null', () => {
    const projection = buildCountedProjection({ toolChoice: 'auto' });
    expect(Object.keys(projection).sort()).toEqual([...COUNTED_PROJECTION_FIELDS].sort());
    expect(projection.toolChoice).toBe('auto');
    expect(projection.prompt).toBeNull();
    expect(projection.maxOutputTokens).toBeNull();
    expect(projection.reasoning).toBeNull();
  });

  test('headers and credentials are never part of the projection or its bytes', () => {
    const projection = buildCountedProjection({
      prompt: 'hello',
      headers: { authorization: 'Bearer SUPER-SECRET' },
      abortSignal: undefined,
    });
    expect(Object.keys(projection)).not.toContain('headers');
    expect(Object.keys(projection)).not.toContain('abortSignal');
    const hex = canonicalProjectionBytesHex(projection);
    expect(hex).not.toContain(Buffer.from('SUPER-SECRET', 'utf8').toString('hex'));
    expect(hex).not.toContain(Buffer.from('headers', 'utf8').toString('hex'));
  });

  test('a real normalized request round-trips its counted projection', () => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fix it' }] }],
      providerOptions: { injected: { marker: 'x' } },
      maxOutputTokens: 64,
      temperature: 0.5,
    };
    const digest = canonicalProjectionDigest(buildCountedProjection(params));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('the authenticated identity is NOT in the canonical document', () => {
    // The canonical domain carries the counted fields ONLY. Job/source/finding/
    // authorization/role/rung/window/sequence are host-bound identity: they must
    // never reach the canonical bytes, so a reader cannot be fooled into treating
    // a caller-supplied identity as authenticated.
    const projection = buildCountedProjection({
      prompt: 'hi',
      job: 'crq-run-20260101T000000Z-F1',
      source_sha: 'a'.repeat(40),
      finding_sha256: 'b'.repeat(64),
      authorization_digest: 'c'.repeat(64),
      role: 'fixer',
      rung: 2,
      window: '2026-01-01T00:00:00Z/2026-01-01T00:10:00Z',
      sequence: 7,
    });
    expect(Object.keys(projection).sort()).toEqual([...COUNTED_PROJECTION_FIELDS].sort());
    const hex = canonicalProjectionBytesHex(projection);
    for (const needle of [
      'crq-run-20260101T000000Z-F1',
      'a'.repeat(40),
      'b'.repeat(64),
      'c'.repeat(64),
      'fixer',
      'window',
      'sequence',
      'authorization',
    ]) {
      expect(hex).not.toContain(Buffer.from(needle, 'utf8').toString('hex'));
    }
  });

  test('the domain tag is part of the document, so digests are domain-separated', () => {
    const value = { prompt: 'hi' };
    expect(canonicalProjectionBytesHex(value)).toContain(
      Buffer.from(CANONICAL_PROJECTION_DOMAIN, 'utf8').toString('hex'),
    );
    const foreign = canonicalProjectionDigestOf(
      canonicalProjectionBytes(value, 'crq/ledger-binding/v2'),
    );
    expect(foreign).not.toBe(canonicalProjectionDigest(value));
  });
});

describe('strict refusals beyond JSON', () => {
  test('an integer-valued number beyond the safe range is refused', () => {
    expect(() => canonicalProjectionBytes(2 ** 53)).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
    expect(() => canonicalProjectionBytes(1e300)).toThrow(CanonicalProjectionUnrepresentableError);
  });

  test('a lone surrogate string is refused rather than replaced', () => {
    expect(hasLoneSurrogate('\uD800')).toBe(true);
    expect(hasLoneSurrogate('\u{1D11E}')).toBe(false);
    expect(() => canonicalProjectionBytes('\uD800')).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('non-plain objects are refused', () => {
    expect(() => canonicalProjectionBytes(new Date(0))).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
    expect(() => canonicalProjectionBytes(new Map())).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('a function value is refused', () => {
    expect(() => canonicalProjectionBytes({ fn: () => 1 })).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('a symbol value is refused', () => {
    expect(() => canonicalProjectionBytes(Symbol('nope'))).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
    expect(() => canonicalProjectionBytes({ sym: Symbol('nope') })).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('binary buffers and typed arrays are refused (not silently framed as maps)', () => {
    // Buffer.from([0]) is what the `bytes` vector descriptor builds; a Uint8Array
    // is a non-plain object, and JSON.stringify would turn it into an object of
    // numeric keys — a shape the other language would misread.
    expect(() => canonicalProjectionBytes(Buffer.from([0]))).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
    expect(() => canonicalProjectionBytes(new Uint8Array([1, 2]))).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('an array or object nested past the depth limit is refused', () => {
    let tooDeep: unknown = 'bottom';
    for (let i = 0; i <= 64; i += 1) tooDeep = [tooDeep];
    expect(() => canonicalProjectionBytes(tooDeep)).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
    let objectDeep: unknown = 'bottom';
    for (let i = 0; i <= 64; i += 1) objectDeep = { nested: objectDeep };
    expect(() => canonicalProjectionBytes(objectDeep)).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });

  test('a JSON-invalid providerOptions payload that JSON would drop is refused', () => {
    // The narrow helper is the ONLY place a JSON-invalid payload enters; the
    // runtime guard must still reject it.
    const projection = buildCountedProjection({
      prompt: 'hi',
      providerOptions: invalidProviderOptions({ injected: { fn: () => 1 } }),
    });
    expect(() => canonicalProjectionBytes(projection)).toThrow(
      CanonicalProjectionUnrepresentableError,
    );
  });
});
