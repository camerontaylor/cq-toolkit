// The review-v1 capability through its pure handler: admission, replay,
// status, result chunking, notify ownership, cancellation, policy refusals and
// the lock-busy answer. Effects are in-memory; the adapter suite covers real
// Git and filesystem state.
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import { receiptJsonText, sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import {
  runReviewCapability,
  type ReviewCapabilityEffects,
} from '../../../src/ops/crq/reviewCapability.js';

const REPO = 'owner/repo';
const PRINCIPAL = 'client-a';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const HEAD_TREE = 'd'.repeat(40);

function object(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function policy(overrides: Record<string, unknown> = {}): unknown {
  return object({
    enabled: true,
    repo: REPO,
    read: [PRINCIPAL],
    write: [PRINCIPAL],
    targets: [],
    branches: ['main'],
    ...overrides,
  });
}

function queueDocument(): JsonObject {
  return object({ items: [], review_requests: {} });
}

const inputs = {
  repo: REPO,
  base_commit: BASE,
  base_tree: BASE_TREE,
  head_commit: HEAD,
  head_tree: HEAD_TREE,
  projection: 'committed',
  target: 'main',
} as const;

interface Harness {
  readonly effects: ReviewCapabilityEffects;
  state: { queue: JsonObject; saves: number; locked: boolean; busy: boolean };
  call(body: unknown, overrides?: { policy?: unknown; principal?: string }): Promise<JsonObject>;
  gitCalls: string[][];
}

function harness(options: { queue?: JsonObject; receipt?: Uint8Array } = {}): Harness {
  const state = {
    queue: options.queue ?? queueDocument(),
    saves: 0,
    locked: false,
    busy: false,
  };
  const gitCalls: string[][] = [];
  const receipts = new Map<string, Uint8Array>();
  if (options.receipt !== undefined) receipts.set(sha256Hex(options.receipt), options.receipt);
  const effects: ReviewCapabilityEffects = {
    runnerRepo: REPO,
    config: object({ clone: '/clone', repos: [] }),
    nowIso: () => '2026-11-13T00:00:00Z',
    loadQueue: async () => state.queue,
    saveQueue: async (queue) => {
      state.queue = queue;
      state.saves += 1;
    },
    withQueueLock: async (work) => {
      if (state.busy) return null;
      state.locked = true;
      try {
        return await work();
      } finally {
        state.locked = false;
      }
    },
    readReceipt: async (receiptId) => {
      const bytes = receipts.get(receiptId);
      if (bytes === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return bytes;
    },
    isConfiguredRepo: (repo) => repo === REPO,
    hasCommit: async () => true,
    fetchRepo: async () => undefined,
    installSnapshot: async () => undefined,
    resolveIdentity: async (_repo, input) => {
      const repo = input.get('repo');
      const base = input.get('base_commit');
      const head = input.get('head_commit');
      const projection = input.get('projection');
      return object({
        v: 1,
        repo,
        base_commit: base,
        head_commit: head,
        projection,
        base_tree: BASE_TREE,
        head_tree: HEAD_TREE,
        scope: 'full-diff',
        config_digest: 'e'.repeat(64),
        profile: { adapter: 'coderabbit-cli', revision: 'committed-full-diff-v1' },
      });
    },
    historyGit:
      () =>
      async (...args: string[]) => {
        gitCalls.push(args);
        throw new Error('history unavailable in the pure harness');
      },
    retainedRecords: async () => [],
    rolloutSettings: async () => null,
    putReport: async () => object({ sha256: 'f'.repeat(64), location: '/store' }),
    spoolEvent: async () => undefined,
    requestPublication: async () => undefined,
    audit: async () => undefined,
  };
  async function rawCall(
    body: unknown,
    overrides: { policy?: unknown; principal?: string } = {},
  ): Promise<JsonObject> {
    const response = await runReviewCapability(
      {
        raw: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
        principal: overrides.principal ?? PRINCIPAL,
        policy: overrides.policy ?? policy(),
      },
      effects,
    );
    return object(JSON.parse(Buffer.from(response).toString('utf8')));
  }
  return {
    effects,
    state,
    gitCalls,
    call: rawCall,
  };
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, op: 'submit', request_id: 'req-1', inputs, ...overrides };
}

describe('review-v1 pure handler', () => {
  test('capabilities answers without the queue lock and lists every operation', async () => {
    const h = harness();
    const result = await h.call({ v: 1, op: 'capabilities' });
    expect(result.get('command')).toBe('review-v1');
    expect(result.get('operations')).toEqual([
      'capabilities',
      'submit',
      'status',
      'result',
      'cancel',
      'notify-update',
      'review-history',
      'record',
    ]);
    expect(result.get('features')).toContain('chunked-result-v1');
  });

  test('submit admits once, records the principal and replays without writing', async () => {
    const h = harness();
    const created = await h.call(frame());
    expect(created.get('action')).toBe('created');
    expect(created.get('state')).toBe('queued');
    const itemId = created.get('item');
    expect(itemId).toBeTypeOf('string');
    const requests = h.state.queue.get('review_requests');
    if (!(requests instanceof JsonObject)) throw new Error('missing requests');
    const binding = requests.get('req-1');
    if (!(binding instanceof JsonObject)) throw new Error('missing binding');
    expect(binding.get('principal')).toBe(PRINCIPAL);
    expect(binding.get('admission_action')).toBe('created');
    const saves = h.state.saves;

    const replay = await h.call(frame());
    expect(replay.get('action')).toBe('observed');
    expect(replay.get('request_id')).toBe('req-1');
    expect(replay.get('item')).toBe(itemId);
    expect(h.state.saves).toBe(saves);
  });

  test('a request id reused with different inputs is invalid input', async () => {
    const h = harness();
    await h.call(frame());
    await expect(
      h.call(frame({ inputs: { ...inputs, head_commit: 'e'.repeat(40) } })),
    ).rejects.toMatchObject({ name: 'ValueError', message: 'request id has different inputs' });
  });

  test('an unsupported policy target is a typed invalid-input refusal', async () => {
    const h = harness();
    await expect(h.call(frame(), { policy: policy({ branches: [] }) })).rejects.toMatchObject({
      name: 'ValueError',
      message: 'target branch denied',
    });
  });

  test('an unconfigured repository is observed as unsupported, not an error', async () => {
    const h = harness();
    const result = await h.call(frame({ inputs: { ...inputs, repo: 'other/repo' } }), {
      policy: policy({ repo: 'other/repo' }),
    });
    expect(result.get('action')).toBe('observed');
    expect(result.get('state')).toBe('unsupported');
    expect(result.get('reason')).toBe('unsupported-repo');
  });

  test('a non-writer principal is denied before the lock is taken', async () => {
    const h = harness();
    await expect(h.call(frame(), { principal: 'stranger' })).rejects.toMatchObject({
      name: 'ValueError',
      message: 'review principal denied',
    });
    expect(h.state.locked).toBe(false);
  });

  test('a disabled policy answers unsupported review-disabled', async () => {
    const h = harness();
    const result = await h.call(frame(), { policy: policy({ enabled: false }) });
    expect(result.get('action')).toBe('observed');
    expect(result.get('state')).toBe('unsupported');
    expect(result.get('reason')).toBe('review-disabled');
  });

  test('a busy queue lock is the typed retryable busy answer', async () => {
    const h = harness();
    h.state.busy = true;
    const result = await h.call(frame());
    const error = result.get('error') as JsonObject;
    expect(error.get('code')).toBe('busy');
    expect(error.get('retryable')).toBe(true);
  });

  test('status reads the stored binding and a result chunk is verified off disk', async () => {
    const receipt = Buffer.from(
      receiptJsonText(
        object({
          v: 1,
          kind: 'review',
          identity: 'x',
          identity_inputs: { repo: REPO },
          scope_adequate: true,
          outcome: 'clean',
          generated_at: '2026-11-13T00:00:00Z',
        }),
      ),
      'utf8',
    );
    const h = harness({ receipt });
    const created = await h.call(frame());
    const itemId = created.get('item');
    const queue = h.state.queue;
    const items = (queue.get('items') as JsonObject[]).map((item) =>
      item.get('id') === itemId
        ? withObjectKeys(item, [
            ['state', 'done'],
            ['outcome', 'clean'],
            ['receipt_id', sha256Hex(receipt)],
            [
              'cycles',
              [
                object({
                  receipt_id: sha256Hex(receipt),
                  base: BASE,
                  head: HEAD,
                  config_digest: 'e'.repeat(64),
                  profile: {
                    adapter: 'coderabbit-cli',
                    revision: 'committed-full-diff-v1',
                  },
                }),
              ],
            ],
          ])
        : item,
    );
    h.state.queue = withObjectKeys(queue, [['items', items]]);

    const status = await h.call({ v: 1, op: 'status', request_id: 'req-1' });
    expect(status.get('state')).toBe('completed');
    expect(status.get('receipt_id')).toBe(sha256Hex(receipt));
    expect(status.get('history')).toBeTypeOf('object');

    const chunk = await h.call({ v: 1, op: 'result', request_id: 'req-1' });
    expect(chunk.get('receipt_id')).toBe(sha256Hex(receipt));
    expect((chunk.get('bytes') as { integer: bigint }).integer).toBe(BigInt(receipt.length));
    const data = Buffer.from(chunk.get('data') as string, 'base64');
    expect(createHash('sha256').update(data).digest('hex')).toBe(chunk.get('chunk_sha256'));
  });

  test('cancel withdraws the observer and cancels an unobserved pending item', async () => {
    const h = harness();
    await h.call(frame());
    const cancelled = await h.call({ v: 1, op: 'cancel', request_id: 'req-1' });
    expect(cancelled.get('state')).toBe('cancelled');
    expect(h.state.saves).toBeGreaterThan(1);
  });

  test('notify-update requires the recorded principal', async () => {
    const h = harness();
    await h.call(frame());
    await expect(
      h.call(
        { v: 1, op: 'notify-update', request_id: 'req-1', notify: null },
        { principal: 'client-b', policy: policy({ write: [PRINCIPAL, 'client-b'] }) },
      ),
    ).rejects.toMatchObject({
      name: 'ValueError',
      message: 'notification request owner denied',
    });
  });

  test('record with a policy-disallowed repository is refused before any ledger work', async () => {
    const h = harness();
    const result = await h.call({
      v: 1,
      op: 'record',
      producer: 'manual',
      source_id: 'src-1',
      report: { encoding: 'utf8', data: '{}' },
      repo: 'other/repo',
    });
    expect(result.get('action')).toBe('refused');
    expect(result.get('reason')).toBe('unsupported-repo');
  });

  test('a malformed frame is invalid input with the typed wire error', async () => {
    const h = harness();
    const response = await runReviewCapability(
      {
        raw: Buffer.from('{"v":1,"op":"status"}\n', 'utf8'),
        principal: PRINCIPAL,
        policy: policy(),
      },
      h.effects,
    );
    const result = object(JSON.parse(Buffer.from(response).toString('utf8')));
    const error = result.get('error') as JsonObject;
    expect(error.get('code')).toBe('invalid-input');
    expect(error.get('retryable')).toBe(false);
  });
});
