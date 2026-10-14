// The canonical cross-language request-projection protocol, version 1 — the
// TypeScript side. It is byte-for-byte the same grammar as the Python
// `crq_repair/canonical.py`, so a Python ledger and this driver compute the SAME
// sha256 for the SAME counted projection. A Python ledger CANNOT bind the older
// TS-local `countableProjectionDigest` (plain `JSON.stringify` of the countable
// object); this module replaces it with the protocol digest.
//
// This is NOT RFC 8785 (JCS). It is a tagged, length-framed BINARY grammar with
// its own magic, version and DOMAIN tag, so no JCS conformance is claimed.
//
// ------------------------------------------------------------------- grammar
//
//   Document := MAGIC VERSION Domain Body
//   MAGIC    := "CRQP"
//   VERSION  := uint16 big-endian (= 1)
//   Domain   := String frame                ("crq/request-projection/v1")
//   Body     := Frame
//   Frame    := tag payload
//     0x00 null | 0x01 false | 0x02 true
//     0x03 int64 big-endian                  (safe integers only)
//     0x04 float64 IEEE-754 bit pattern      (finite; -0 kept)
//     0x05 uint32 byte length + UTF-8 bytes  (string)
//     0x06 uint32 count + Frame*             (array)
//     0x07 uint32 count + (Frame Frame)*     (map, keys ascending by UTF-8 bytes)
//
// NUMBER RULE (identical in both languages, value-based not type-based):
//   * non-finite (NaN, +/-Infinity) is UNREPRESENTABLE;
//   * negative zero is the float64 bit pattern 0x8000000000000000 (tag 0x04);
//   * an integer-valued number with |v| <= 2^53-1 and not -0 is tag 0x03, so
//     0 and 0.0 encode identically;
//   * an integer-valued number outside the safe range is UNREPRESENTABLE (a
//     double cannot hold it and Python's int would diverge: refusing is the
//     only cross-language-honest answer);
//   * every other finite number is tag 0x04.
//
// STRING RULE: UTF-8 bytes, uint32 length-framed. A lone surrogate cannot be
// encoded to UTF-8 and is UNREPRESENTABLE (Node's Buffer.from would silently
// substitute U+FFFD, so this module checks first).
//
// MAP RULE: keys are strings sorted by their UTF-8 BYTE sequence — deliberately
// NOT JavaScript's default UTF-16 code-unit order, which differs for
// supplementary characters against U+E000..U+FFFF. Only plain objects
// (Object.prototype or null prototype) are maps; Date/Map/Set/Buffer/class
// instances/arrays-with-holes/etc. are UNREPRESENTABLE.
//
// `undefined` follows JSON: an absent value has no frame, so a property whose
// value is `undefined` is DROPPED (matching JSON.stringify) and a top-level
// `undefined` is a refusal at the caller. The counted projection builder never
// produces `undefined` — it maps every missing field to `null`.
//
// STRICTNESS: cycles and values nested past MAX_DEPTH are UNREPRESENTABLE.
// Nothing here reads the environment, a credential, a file or a provider.
//
// ------------------------------------------------------------------- status
//
// No interoperability claim is made. The shared byte+digest vectors are
// produced by THIS implementation and the Python side reproduces them in a test
// that is AUTHORED BUT NOT RUN in this lane, so cross-language equality is
// UNPROVEN until that test executes. Source-level agreement is all that is
// claimed here.
import { createHash } from 'node:crypto';

export const CANONICAL_PROJECTION_MAGIC = 'CRQP';
export const CANONICAL_PROJECTION_VERSION = 1;
export const CANONICAL_PROJECTION_DOMAIN = 'crq/request-projection/v1';
export const CANONICAL_PROJECTION_PROTOCOL = CANONICAL_PROJECTION_DOMAIN;
export const CANONICAL_PROJECTION_MAX_DEPTH = 64;
export const CANONICAL_PROJECTION_SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** The exact fields of the counted projection, in documented order. The map
 *  encoding sorts by UTF-8 key bytes, so this order is not wire order. */
export const COUNTED_PROJECTION_FIELDS = [
  'prompt',
  'tools',
  'toolChoice',
  'responseFormat',
  'providerOptions',
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'reasoning',
] as const;

export type CountedProjectionField = (typeof COUNTED_PROJECTION_FIELDS)[number];

/** The immutable counted projection: exactly the shared fields, nothing else. */
export type CountedProjection = { readonly [K in CountedProjectionField]: unknown };

const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_INT = 0x03;
const TAG_FLOAT = 0x04;
const TAG_STRING = 0x05;
const TAG_ARRAY = 0x06;
const TAG_MAP = 0x07;

/** A value or a map key the shared grammar cannot represent byte-for-byte in
 *  both languages. The caller fails closed; it must never substitute a lossy
 *  encoding. */
export class CanonicalProjectionUnrepresentableError extends Error {
  constructor(detail: string) {
    super(`canonical projection: ${detail}`);
    this.name = 'CanonicalProjectionUnrepresentableError';
  }
}

function refuse(detail: string): never {
  throw new CanonicalProjectionUnrepresentableError(detail);
}

function u32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function stringFrame(value: string): Buffer {
  if (hasLoneSurrogate(value)) {
    refuse('a string containing a lone surrogate is not representable');
  }
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([TAG_STRING]), u32(data.length), data]);
}

/** True when `value` holds an unpaired UTF-16 surrogate. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function intFrame(value: number): Buffer {
  if (!Number.isSafeInteger(value)) {
    refuse('an integer outside the IEEE-754 safe range is not representable in both languages');
  }
  const out = Buffer.allocUnsafe(9);
  out.writeUInt8(TAG_INT, 0);
  out.writeBigInt64BE(BigInt(value), 1);
  return out;
}

function floatFrame(value: number): Buffer {
  const out = Buffer.allocUnsafe(9);
  out.writeUInt8(TAG_FLOAT, 0);
  out.writeDoubleBE(value, 1);
  return out;
}

function numberFrame(value: number): Buffer {
  if (!Number.isFinite(value)) {
    refuse('a non-finite number (NaN or Infinity) is not representable');
  }
  if (Object.is(value, -0)) return floatFrame(-0);
  if (Number.isSafeInteger(value)) return intFrame(value);
  if (Number.isInteger(value)) {
    refuse('an integer-valued number outside the IEEE-754 safe range is not representable');
  }
  return floatFrame(value);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function frame(value: unknown, depth: number, seen: Set<object>): Buffer {
  if (value === null || value === undefined) return Buffer.from([TAG_NULL]);
  if (value === true) return Buffer.from([TAG_TRUE]);
  if (value === false) return Buffer.from([TAG_FALSE]);
  if (typeof value === 'number') return numberFrame(value);
  if (typeof value === 'string') return stringFrame(value);
  if (Array.isArray(value)) {
    if (depth >= CANONICAL_PROJECTION_MAX_DEPTH) {
      refuse(`an array nested past the depth limit ${CANONICAL_PROJECTION_MAX_DEPTH}`);
    }
    if (seen.has(value)) refuse('a cycle is not representable');
    seen.add(value);
    try {
      const parts: Buffer[] = [Buffer.from([TAG_ARRAY]), u32(value.length)];
      for (const item of value) parts.push(frame(item, depth + 1, seen));
      return Buffer.concat(parts);
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      refuse(`a value whose prototype is not Object.prototype/null is not representable`);
    }
    if (depth >= CANONICAL_PROJECTION_MAX_DEPTH) {
      refuse(`an object nested past the depth limit ${CANONICAL_PROJECTION_MAX_DEPTH}`);
    }
    if (seen.has(value)) refuse('a cycle is not representable');
    seen.add(value);
    try {
      // Sort by UTF-8 BYTES, never by UTF-16 code units.
      const keys = Object.keys(value as Record<string, unknown>).map((key) => ({
        key,
        bytes: keyBytes(key),
      }));
      keys.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
      const parts: Buffer[] = [Buffer.from([TAG_MAP]), u32(keys.length)];
      for (const entry of keys) {
        parts.push(
          Buffer.concat([Buffer.from([TAG_STRING]), u32(entry.bytes.length), entry.bytes]),
        );
        parts.push(frame((value as Record<string, unknown>)[entry.key], depth + 1, seen));
      }
      return Buffer.concat(parts);
    } finally {
      seen.delete(value);
    }
  }
  refuse(`a value of type ${typeof value} is not representable`);
}

function keyBytes(key: string): Buffer {
  if (hasLoneSurrogate(key)) {
    refuse('a map key containing a lone surrogate is not representable');
  }
  return Buffer.from(key, 'utf8');
}

/**
 * The complete canonical document bytes: magic, version, domain and body.
 * Throws {@link CanonicalProjectionUnrepresentableError} on a value the shared
 * grammar cannot represent.
 */
export function canonicalProjectionBytes(
  value: unknown,
  domain: string = CANONICAL_PROJECTION_DOMAIN,
): Buffer {
  const header = Buffer.concat([
    Buffer.from(CANONICAL_PROJECTION_MAGIC, 'ascii'),
    (() => {
      const out = Buffer.allocUnsafe(2);
      out.writeUInt16BE(CANONICAL_PROJECTION_VERSION, 0);
      return out;
    })(),
    stringFrame(domain),
  ]);
  return Buffer.concat([header, frame(value, 0, new Set<object>())]);
}

/** The canonical document as lowercase hex, the exact wire form a bridge carries. */
export function canonicalProjectionBytesHex(value: unknown): string {
  return canonicalProjectionBytes(value).toString('hex');
}

/** The sha256 hex of a canonical document's bytes (preamble included). */
export function canonicalProjectionDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The sha256 hex of the canonical document for `value`. */
export function canonicalProjectionDigest(value: unknown): string {
  return canonicalProjectionDigestOf(canonicalProjectionBytes(value));
}

/**
 * The driver's counted projection: every counted field of a normalized request
 * in the shared shape, with a missing field as `null`. This is the object the
 * canonical encoder hashes and the object the wire must carry.
 */
export function buildCountedProjection(params: Record<string, unknown>): CountedProjection {
  return {
    prompt: params.prompt ?? null,
    tools: params.tools ?? null,
    toolChoice: params.toolChoice ?? null,
    responseFormat: params.responseFormat ?? null,
    providerOptions: params.providerOptions ?? null,
    maxOutputTokens: params.maxOutputTokens ?? null,
    temperature: params.temperature ?? null,
    topP: params.topP ?? null,
    topK: params.topK ?? null,
    presencePenalty: params.presencePenalty ?? null,
    frequencyPenalty: params.frequencyPenalty ?? null,
    stopSequences: params.stopSequences ?? null,
    seed: params.seed ?? null,
    reasoning: params.reasoning ?? null,
  };
}
