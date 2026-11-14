// The author-v1 capability through its pure handler: lease enrollment,
// status, fallback timing, immutable-binding refusals and a version-2
// snapshot enrollment. Snapshot installation itself is mocked here; the
// installer's own validation is covered by the decode assertions and the
// adapter suite.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  runAuthorCapability,
  type AuthorCapabilityEffects,
} from '../../../src/ops/crq/authorCapability.js';
import { decodeSnapshot } from '../../../src/policy/crq/authorSnapshot.js';

const BASE = 'a'.repeat(40);
const TARGET = 'origin/main';
const REVIEWER = 'reviewer-agent';
const POLICY = '/etc/crq/review-policy.json';

function object(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function sha1(header: string, data: Uint8Array): string {
  return createHash('sha1').update(header).update(data).digest('hex');
}

function commitBytes(base: string, tree: string): Uint8Array {
  return Buffer.from(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
    'utf8',
  );
}

function snapshotFixture(): { snapshot: Record<string, unknown>; head: string } {
  const blob = Buffer.from('hello\n', 'utf8');
  const blobOid = sha1(`blob ${String(blob.length)}\0`, blob);
  const entry = Buffer.concat([
    Buffer.from(`100644 hello.txt\0`, 'utf8'),
    Buffer.from(blobOid, 'hex'),
  ]);
  const treeOid = sha1(`tree ${String(entry.length)}\0`, entry);
  const objects = [
    { oid: blobOid, type: 'blob', data: blob.toString('base64') },
    { oid: treeOid, type: 'tree', data: entry.toString('base64') },
  ].sort((left, right) => left.oid.localeCompare(right.oid));
  const digest = createHash('sha256');
  for (const value of objects) {
    digest.update(`${value.oid}\0${value.type}\0${value.data}\n`);
  }
  const commit = commitBytes(BASE, treeOid);
  const head = sha1(`commit ${String(commit.length)}\0`, commit);
  return {
    snapshot: {
      v: 1,
      tree: treeOid,
      objects,
      sha256: digest.digest('hex'),
    },
    head,
  };
}

interface Harness {
  readonly effects: AuthorCapabilityEffects;
  state: {
    queue: JsonObject;
    now: string;
    saves: number;
    audits: unknown[];
    installs: unknown[];
    statuses: number;
  };
  call(body: unknown, overrides?: { target?: string }): Promise<JsonObject>;
}

function harness(queue: JsonObject = object({ items: [], author_requests: {} })): Harness {
  const state = {
    queue,
    now: '2026-11-13T00:00:00Z',
    saves: 0,
    audits: [] as unknown[],
    installs: [] as unknown[],
    statuses: 0,
  };
  const effects: AuthorCapabilityEffects = {
    nowIso: () => state.now,
    loadQueue: async () => state.queue,
    saveQueue: async (value) => {
      state.queue = value;
      state.saves += 1;
    },
    withQueueLock: async (work) => work(),
    readPolicy: async () => object({ review: { reviewerTimeoutMin: 5 } }),
    installSnapshot: async (binding, snapshot) => {
      state.installs.push({ binding, snapshot });
    },
    audit: async (kind, data) => {
      state.audits.push({ kind, data });
    },
    writeStatus: async () => {
      state.statuses += 1;
    },
  };
  return {
    effects,
    state,
    async call(body, overrides = {}) {
      const response = await runAuthorCapability(
        {
          raw: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
          policyPath: POLICY,
          reviewer: REVIEWER,
          approvedTarget: overrides.target ?? TARGET,
        },
        effects,
      );
      return object(JSON.parse(Buffer.from(response).toString('utf8')));
    },
  };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'req-1',
    base: BASE,
    head: 'b'.repeat(40),
    target: TARGET,
    cycle: 1,
    ...overrides,
  };
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, op: 'enroll', binding: binding(), ...overrides };
}

describe('author-v1 pure handler', () => {
  test('enrollment creates the pending author item with a waiting lease', async () => {
    const h = harness();
    const result = await h.call(frame());
    expect(result.get('request_id')).toBe('req-1');
    expect(result.get('issuer')).toBe('waiting');
    expect(result.get('reviewer')).toBeNull();
    expect(result.get('deadline_at')).toBe('2026-11-13T00:05:00Z');
    expect(result.get('dispatch')).toBe(false);
    const items = h.state.queue.get('items') as JsonObject[];
    expect(items).toHaveLength(1);
    expect(items[0]?.get('state')).toBe('pending');
    const lease = items[0]?.get('author_lease');
    expect(lease).toBeInstanceOf(JsonObject);
    expect((lease as JsonObject).get('reviewer')).toBe(REVIEWER);
    expect(h.state.audits).toHaveLength(1);
    expect(h.state.statuses).toBe(1);
  });

  test('status is read-only and idempotent enrollment keeps the same item', async () => {
    const h = harness();
    const first = await h.call(frame());
    const saves = h.state.saves;
    const replay = await h.call(frame());
    expect(replay.get('request_id')).toBe(first.get('request_id'));
    expect(replay.get('deadline_at')).toBe(first.get('deadline_at'));
    expect(h.state.saves).toBe(saves + 1);
    expect((h.state.queue.get('items') as JsonObject[]).length).toBe(1);
    const status = await h.call({ v: 1, op: 'status', binding: binding() });
    expect(status.get('issuer')).toBe('waiting');
    expect(h.state.saves).toBe(saves + 1);
  });

  test('fallback before the deadline is refused and after it grants once', async () => {
    const h = harness();
    await h.call(frame());
    await expect(h.call({ v: 1, op: 'fallback', binding: binding() })).rejects.toMatchObject({
      name: 'AuthorRefused',
      message: 'author fallback before lease deadline',
    });
    h.state.now = '2026-11-13T00:06:00Z';
    const granted = await h.call({ v: 1, op: 'fallback', binding: binding() });
    expect(granted.get('issuer')).toBe('agent');
    expect(granted.get('reviewer')).toBe(REVIEWER);
    expect(granted.get('dispatch')).toBe(true);
    const item = (h.state.queue.get('items') as JsonObject[])[0] as JsonObject;
    expect(item.get('state')).toBe('skipped');
    const again = await h.call({ v: 1, op: 'fallback', binding: binding() });
    expect(again.get('dispatch')).toBe(false);
  });

  test('a conflicting binding under the same request id is refused', async () => {
    const h = harness();
    await h.call(frame());
    await expect(h.call(frame({ binding: binding({ head: 'c'.repeat(40) }) }))).rejects.toThrow(
      'already enrolled with a different binding',
    );
  });

  test('the operator-approved target is mandatory', async () => {
    const h = harness();
    await expect(h.call(frame(), { target: 'origin/other' })).rejects.toMatchObject({
      name: 'AuthorRefused',
      message: 'operator-approved author target required',
    });
  });

  test('a version-2 enrollment installs the snapshot before the durable item', async () => {
    const h = harness();
    const fixture = snapshotFixture();
    const result = await h.call({
      v: 2,
      op: 'enroll',
      binding: binding({ head: fixture.head }),
      snapshot: fixture.snapshot,
    });
    expect(result.get('issuer')).toBe('waiting');
    expect(h.state.installs).toHaveLength(1);
    expect((h.state.queue.get('items') as JsonObject[]).length).toBe(1);
  });

  test('a snapshot whose digest does not match the decoder is refused', () => {
    const fixture = snapshotFixture();
    const snapshot = object({ ...fixture.snapshot, sha256: '0'.repeat(64) });
    expect(() => decodeSnapshot(snapshot, { base: BASE, head: fixture.head }, false)).toThrowError(
      'snapshot sha256 does not match its objects',
    );
  });

  test('a snapshot-sized canonical base64 object decodes without regex recursion', () => {
    const data = Buffer.alloc(3_500_000, 7);
    const oid = sha1(`blob ${String(data.length)}\0`, data);
    const tree = 'c'.repeat(40);
    const commit = commitBytes(BASE, tree);
    const head = sha1(`commit ${String(commit.length)}\0`, commit);
    const objects = [{ oid, type: 'blob', data: data.toString('base64') }];
    const digest = createHash('sha256');
    for (const value of objects) {
      digest.update(`${value.oid}\0${value.type}\0${value.data}\n`);
    }
    const snapshot = object({ v: 1, tree, objects, sha256: digest.digest('hex') });
    expect(() => decodeSnapshot(snapshot, { base: BASE, head }, false)).not.toThrow();
  });

  test('a v2 frame with a status operation is refused by the decoder', async () => {
    const h = harness();
    await expect(
      h.call({
        v: 2,
        op: 'status',
        binding: binding(),
        snapshot: snapshotFixture().snapshot,
      }),
    ).rejects.toMatchObject({ name: 'AuthorRefused', message: 'snapshots are enrollment only' });
  });
});
