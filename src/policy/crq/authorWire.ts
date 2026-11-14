/**
 * Author-v1 forced-command frame (`author_transport.decode`).
 *
 * The frame selects one of three operations and carries an immutable binding;
 * all authority still comes from the operator's environment. Version 2 adds
 * one snapshot to `enroll` only. Duplicate keys, unknown fields and control
 * characters are refused before any queue access.
 */
import { JsonNumber, JsonObject, parseJsonValue } from './jsonValue.js';

/** `author_transport.MAX_BYTES`: the version-1 request bound. */
export const AUTHOR_MAX_BYTES = 8192;
/** `author_transport.MAX_SNAPSHOT_BYTES`: the version-2 request bound. */
export const AUTHOR_MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
/** `author_quota.REQUEST_ID_RE`. */
export const AUTHOR_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** `author_quota.SHA_RE`. */
export const AUTHOR_SHA = /^[0-9a-f]{40}$/;
/** `author_quota.TARGET_RE`. */
export const AUTHOR_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** `author_quota.MAX_CYCLE`. */
export const AUTHOR_MAX_CYCLE = 2;

/** A refused author request; nothing was written. */
export class AuthorRefused extends Error {
  override readonly name: string = 'AuthorRefused';
}

/** The immutable identity of one author request. */
export interface AuthorBinding {
  readonly requestId: string;
  readonly base: string;
  readonly head: string;
  readonly target: string;
  readonly cycle: bigint;
}

export interface AuthorRequest {
  /** Transport version. */
  readonly v: number;
  readonly op: 'enroll' | 'status' | 'fallback';
  readonly binding: AuthorBinding;
  /** Present only for a version-2 enrollment. */
  readonly snapshot: JsonObject | null;
}

/** `author_quota.normalize_binding`, with the Python refusal vocabulary. */
export function normalizeBinding(input: {
  requestId: unknown;
  base: unknown;
  head: unknown;
  target: unknown;
  cycle: unknown;
}): AuthorBinding {
  if (typeof input.requestId !== 'string' || !AUTHOR_REQUEST_ID.test(input.requestId)) {
    throw new AuthorRefused('request_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}');
  }
  if (typeof input.base !== 'string' || !AUTHOR_SHA.test(input.base)) {
    throw new AuthorRefused('base must be a 40-hex immutable commit sha');
  }
  if (typeof input.head !== 'string' || !AUTHOR_SHA.test(input.head)) {
    throw new AuthorRefused('head must be a 40-hex immutable commit sha');
  }
  if (input.base === input.head) throw new AuthorRefused('base and head are the same commit');
  if (typeof input.target !== 'string' || !AUTHOR_TARGET.test(input.target)) {
    throw new AuthorRefused('target must be a ref name like origin/main');
  }
  if (
    !(input.cycle instanceof JsonNumber) ||
    input.cycle.kind !== 'int' ||
    input.cycle.integer === null ||
    input.cycle.integer < 1n ||
    input.cycle.integer > BigInt(AUTHOR_MAX_CYCLE)
  ) {
    throw new AuthorRefused(`cycle must be an integer 1..${String(AUTHOR_MAX_CYCLE)}`);
  }
  return {
    requestId: input.requestId,
    base: input.base,
    head: input.head,
    target: input.target,
    cycle: input.cycle.integer,
  };
}

/** The binding as the queue stores it (`{request_id,base,head,target,cycle}`). */
export function bindingObject(binding: AuthorBinding): JsonObject {
  return new JsonObject([
    ['request_id', binding.requestId],
    ['base', binding.base],
    ['head', binding.head],
    ['target', binding.target],
    ['cycle', JsonNumber.int(binding.cycle)],
  ]);
}

/** `binding_of`: the four identity fields, in Python's order. */
export function bindingOf(entry: JsonObject): JsonObject {
  return new JsonObject([
    ['base', entry.get('base') ?? null],
    ['head', entry.get('head') ?? null],
    ['target', entry.get('target') ?? null],
    ['cycle', entry.get('cycle') ?? null],
  ]);
}

export function bindingsEqual(left: JsonObject, right: JsonObject): boolean {
  return (['base', 'head', 'target', 'cycle'] as const).every((key) =>
    jsonScalarEqual(left.get(key), right.get(key)),
  );
}

function jsonScalarEqual(left: unknown, right: unknown): boolean {
  if (left instanceof JsonNumber && right instanceof JsonNumber) {
    return left.kind === right.kind && left.raw === right.raw;
  }
  return left === right;
}

/** `author_transport.decode`. */
export function decodeAuthorRequest(raw: Uint8Array): AuthorRequest {
  if (raw.length > AUTHOR_MAX_SNAPSHOT_BYTES) {
    throw new AuthorRefused('request exceeds transport bound');
  }
  let parsed: unknown;
  try {
    parsed = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(raw), {
      duplicates: 'error',
    });
  } catch {
    throw new AuthorRefused('invalid JSON request');
  }
  if (!(parsed instanceof JsonObject)) throw new AuthorRefused('invalid request');
  const version = parsed.get('v');
  const snapshotMode =
    version instanceof JsonNumber && version.kind === 'int' && version.integer === 2n;
  const fields = snapshotMode ? ['v', 'op', 'binding', 'snapshot'] : ['v', 'op', 'binding'];
  if (parsed.entries.length !== fields.length || !fields.every((field) => parsed.has(field))) {
    throw new AuthorRefused('unknown request fields');
  }
  if (
    !(version instanceof JsonNumber) ||
    version.kind !== 'int' ||
    version.integer === null ||
    (version.integer !== 1n && version.integer !== 2n)
  ) {
    throw new AuthorRefused('unsupported transport version');
  }
  const op = parsed.get('op');
  if (op !== 'enroll' && op !== 'status' && op !== 'fallback') {
    throw new AuthorRefused('unsupported operation');
  }
  if (version.integer === 1n && raw.length > AUTHOR_MAX_BYTES) {
    throw new AuthorRefused('request exceeds v1 bound');
  }
  if (version.integer === 2n && op !== 'enroll') {
    throw new AuthorRefused('snapshots are enrollment only');
  }
  const bindingValue = parsed.get('binding');
  if (!(bindingValue instanceof JsonObject)) throw new AuthorRefused('invalid binding fields');
  const keys = ['request_id', 'base', 'head', 'target', 'cycle'];
  if (bindingValue.entries.length !== keys.length || !keys.every((key) => bindingValue.has(key))) {
    throw new AuthorRefused('invalid binding fields');
  }
  for (const value of bindingValue.entries.map(([, entry]) => entry)) {
    if (
      typeof value === 'string' &&
      [...value].some((character) => character.codePointAt(0)! <= 32)
    ) {
      throw new AuthorRefused('binding contains whitespace or controls');
    }
  }
  const snapshot = parsed.get('snapshot');
  return {
    v: Number(version.integer),
    op,
    binding: normalizeBinding({
      requestId: bindingValue.get('request_id'),
      base: bindingValue.get('base'),
      head: bindingValue.get('head'),
      target: bindingValue.get('target'),
      cycle: bindingValue.get('cycle'),
    }),
    snapshot: snapshot instanceof JsonObject ? snapshot : null,
  };
}
