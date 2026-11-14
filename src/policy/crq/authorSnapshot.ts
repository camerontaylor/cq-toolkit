/**
 * Version-2 author snapshot decoding (`author_snapshot.decode`).
 *
 * The snapshot is the only frame that carries object bytes, so decoding is
 * exact: four fields, a sorted unique object list, canonical base64, and one
 * sha256 over the canonical `oid\\0type\\0data\\n` stream. Every declared oid
 * is re-derived from its bytes; nothing trusts the frame's own labels.
 */
import { createHash } from 'node:crypto';
import { JsonNumber, JsonObject } from './jsonValue.js';
import { AuthorRefused } from './authorWire.js';

/** Snapshot shape bound for a reachable history (`MAX_BYTES`). */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** Snapshot shape bound when the unreachable original commit is carried. */
export const SNAPSHOT_MAX_ORIGINAL_BYTES = 3 * 1024 * 1024;
/** Object-count bound. */
export const SNAPSHOT_MAX_OBJECTS = 4096;

const SHA40 = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface SnapshotObject {
  readonly oid: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly data: Uint8Array;
}

export interface DecodedSnapshot {
  readonly tree: string;
  readonly objects: readonly SnapshotObject[];
  /** The exact synthetic commit bytes the runner must install. */
  readonly headCommit: Uint8Array;
}

function strictBase64(encoded: string): Uint8Array {
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    throw new AuthorRefused('snapshot object data is not canonical base64');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new AuthorRefused('snapshot object data is not canonical base64');
  }
  return new Uint8Array(decoded);
}

/** The synthetic commit Python builds for a snapshot head (`commit_and_time`). */
export function snapshotCommitBytes(base: string, tree: string): Uint8Array {
  return new TextEncoder().encode(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
  );
}

function oidOf(type: string, data: Uint8Array): string {
  const header = new TextEncoder().encode(`${type} ${String(data.length)}\0`);
  const bytes = Buffer.concat([Buffer.from(header), Buffer.from(data)]);
  return sha1Hex(bytes);
}

/** `author_snapshot.decode`. */
export function decodeSnapshot(
  snapshot: JsonObject,
  binding: { readonly base: string; readonly head: string },
  original: boolean,
): DecodedSnapshot {
  const fields = ['v', 'tree', 'objects', 'sha256'];
  if (snapshot.entries.length !== fields.length || !fields.every((field) => snapshot.has(field))) {
    throw new AuthorRefused('snapshot must contain exactly v, tree, objects and sha256');
  }
  const version = snapshot.get('v');
  if (!(version instanceof JsonNumber) || version.kind !== 'int' || version.integer !== 1n) {
    throw new AuthorRefused('unsupported snapshot version');
  }
  const tree = snapshot.get('tree');
  if (typeof tree !== 'string' || !SHA40.test(tree)) {
    throw new AuthorRefused('snapshot tree must be a 40-character git object id');
  }
  const digest = snapshot.get('sha256');
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new AuthorRefused('snapshot sha256 must be 64 lowercase hex characters');
  }
  const values = snapshot.get('objects');
  if (!Array.isArray(values) || values.length === 0) {
    throw new AuthorRefused('snapshot objects must be a non-empty list');
  }
  const objects: SnapshotObject[] = [];
  let total = 0;
  let previous: string | null = null;
  for (const entry of values) {
    if (!(entry instanceof JsonObject))
      throw new AuthorRefused('snapshot object must be an object');
    const keys = ['oid', 'type', 'data'];
    if (entry.entries.length !== keys.length || !keys.every((key) => entry.has(key))) {
      throw new AuthorRefused('snapshot object must contain exactly oid, type and data');
    }
    const oid = entry.get('oid');
    const type = entry.get('type');
    const encoded = entry.get('data');
    if (typeof oid !== 'string' || !SHA40.test(oid)) {
      throw new AuthorRefused('snapshot object oid must be a 40-character git object id');
    }
    if (previous !== null && oid <= previous) {
      throw new AuthorRefused('snapshot objects must be ordered by oid with no duplicates');
    }
    previous = oid;
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') {
      throw new AuthorRefused('snapshot object type must be blob, tree or commit');
    }
    if (typeof encoded !== 'string') {
      throw new AuthorRefused('snapshot object data must be canonical base64');
    }
    const data = strictBase64(encoded);
    total += data.length;
    if (oidOf(type, data) !== oid) {
      throw new AuthorRefused(`snapshot object ${oid} data does not hash to its oid`);
    }
    objects.push({ oid, type, data });
  }
  if (objects.length > SNAPSHOT_MAX_OBJECTS) {
    throw new AuthorRefused(`snapshot carries more than ${String(SNAPSHOT_MAX_OBJECTS)} objects`);
  }
  const bound = original ? SNAPSHOT_MAX_ORIGINAL_BYTES : SNAPSHOT_MAX_BYTES;
  if (total > bound) {
    throw new AuthorRefused(
      original
        ? 'snapshot carries more than 3 MiB of original-commit objects; mark the commit reachable on origin and omit the snapshot'
        : 'snapshot carries more than 4 MiB of objects; push the head commit to origin and omit the snapshot',
    );
  }
  const hash = sha256();
  for (const object of objects) {
    hash.update(object.oid);
    hash.update('\0');
    hash.update(object.type);
    hash.update('\0');
    hash.update(Buffer.from(object.data).toString('base64'));
    hash.update('\n');
  }
  if (hash.digest('hex') !== digest)
    throw new AuthorRefused('snapshot sha256 does not match its objects');
  let headCommit: Uint8Array;
  if (original) {
    const commit = objects.find((object) => object.oid === binding.head);
    if (commit === undefined || commit.type !== 'commit') {
      throw new AuthorRefused('an original snapshot must carry the head commit object');
    }
    const text = Buffer.from(commit.data).toString('utf8');
    if (!text.startsWith(`tree ${tree}\n`)) {
      throw new AuthorRefused('the original head commit does not name the snapshot tree');
    }
    headCommit = commit.data;
  } else {
    headCommit = snapshotCommitBytes(binding.base, tree);
    if (oidOf('commit', headCommit) !== binding.head) {
      throw new AuthorRefused('snapshot commit sha does not match the request head');
    }
  }
  return { tree, objects, headCommit };
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function sha256(): ReturnType<typeof createHash> {
  return createHash('sha256');
}
