import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import {
  prepareInventory,
  type InventoryPreparationEffects,
} from '../../../src/adapters/crq/backfillPreparation.js';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  replay: vi.fn(),
  effectiveLimits: vi.fn(),
  construct: vi.fn(),
  summary: vi.fn(),
  findingTriage: vi.fn(),
}));
vi.mock('../../../src/policy/crq/backfillInventory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/policy/crq/backfillInventory.js')>()),
  capture: mocks.capture,
  replay: mocks.replay,
  effectiveLimits: mocks.effectiveLimits,
}));
vi.mock('../../../src/policy/crq/backfillSubjects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/policy/crq/backfillSubjects.js')>()),
  construct: mocks.construct,
}));
vi.mock('../../../src/policy/crq/backfillReport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/policy/crq/backfillReport.js')>()),
  summary: mocks.summary,
  findingTriage: mocks.findingTriage,
}));

function doc(text: string): JsonObject {
  const result = parseJsonValue(text);
  if (!(result instanceof JsonObject)) throw new Error('expected object');
  return result;
}

function fixture() {
  const calls: string[] = [];
  const member = { pr: 7 };
  const input = {
    target: 'tip',
    ledgerHead: 'head',
    events: [],
    required: {},
    tiers: {},
    limits: {},
    requiredPaths: {},
    members: { '7': member },
    protectedBytes: new Uint8Array(),
  };
  const effects = {
    accounting: {
      beginInvocation: () => {
        calls.push('reset');
      },
    },
    subjects: {},
    artifacts: { read: async () => ({ backfill_scope_failures: { retained: true } }) },
    acquire: async () => {
      calls.push('acquire');
      return input;
    },
    now: () => '2026-01-01T00:00:00Z',
    baseline: async () => null,
    triage: async () => [],
    enqueue: (queue: JsonObject, partition: Record<string, unknown>) => {
      calls.push(
        `enqueue:${String(partition['subject_kind'])}:${String(partition['tier_importance'])}`,
      );
      const item = doc('{"id":"job"}');
      return { queue: withObjectKeys(queue, [['items', [item]]]), item };
    },
  } as unknown as InventoryPreparationEffects;
  return { effects, calls, member, input };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capture.mockResolvedValue({ snapshots: { queue: 'queue-ref' } });
  mocks.replay.mockResolvedValue({ candidates: [{ prs: [7, 8] }], paths: [] });
  mocks.construct.mockResolvedValue({
    partitions: [{ kind: 'path', tier: 'high' }],
    debt: [{ reason: 'unsupported' }],
  });
  mocks.findingTriage.mockReturnValue({ counts: { pending: 1 } });
  mocks.summary.mockResolvedValue({ status: 'ok' });
});

describe('inventory preparation', () => {
  it('resets invocation, captures and prepares partitions with retained failures', async () => {
    const f = fixture();
    const original = doc('{"items":[],"unknown":9007199254740993}');
    const result = await prepareInventory(original, true, f.effects);
    expect(f.calls).toEqual(['reset', 'acquire', 'enqueue:path:high']);
    expect(mocks.effectiveLimits).toHaveBeenCalledWith(f.input.limits, { requireVerified: true });
    expect(mocks.construct).toHaveBeenCalledWith(
      f.effects.subjects,
      { prs: [7, 8] },
      f.input.limits,
      [f.member],
    );
    expect(result.eventItems).toEqual(['job']);
    expect(result.queue.get('unknown')).toEqual(original.get('unknown'));
    expect(result.queue.get('backfill_scope_failures')).toEqual(doc('{"retained":true}'));
    expect(result.report).toEqual({ status: 'ok', construction_debt: [{ reason: 'unsupported' }] });
    expect(original.get('backfill_last_manifest')).toBeUndefined();
  });
  it('report-only skips limit validation and enqueue construction', async () => {
    const f = fixture();
    const result = await prepareInventory(doc('{"items":[]}'), false, f.effects);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.effectiveLimits).not.toHaveBeenCalled();
    expect(result.eventItems).toEqual([]);
    expect(result.report).toEqual({ status: 'ok', construction_debt: [] });
  });
  it('refuses malformed retained queue before enqueue', async () => {
    const f = fixture();
    f.effects.artifacts.read = async () => null;
    await expect(prepareInventory(doc('{"items":[]}'), true, f.effects)).rejects.toThrow(
      'inventory queue snapshot missing',
    );
    expect(mocks.construct).not.toHaveBeenCalled();
  });
});

describe('inventory retire and enqueue cap', () => {
  const row = (id: string, extra: string): string =>
    `{"id":"${id}","kind":"backfill","state":"pending","created_at":"2026-01-01T00:00:00Z",${extra}}`;
  const queueOf = (...rows: string[]): JsonObject => doc(`{"items":[${rows.join(',')}]}`);
  const state = (queue: JsonObject, id: string): JsonObject => {
    const found = (queue.get('items') as JsonObject[]).find((i) => i.get('id') === id);
    if (found === undefined) throw new Error(`missing ${id}`);
    return found;
  };

  /** The default fixture enqueue replaces the items; these tests need the seeded ones to survive. */
  const keepItems = (f: ReturnType<typeof fixture>): void => {
    f.effects.enqueue = (queue) => ({ queue, item: doc('{"id":"job"}') });
  };

  it('retires before capture: stale pins, but not the current pin or execution owners', async () => {
    const f = fixture();
    const queue = queueOf(
      row('old', '"target":"older"'),
      row('keep', '"target":"tip"'),
      row('live', '"target":"older","vendor_state":"live"'),
      '{"id":"other","kind":"review","state":"pending","target":"older"}',
    );
    const result = await prepareInventory(queue, true, f.effects, { retire: true });
    const captured = mocks.capture.mock.calls[0]?.[0] as { queue: JsonObject };
    expect(state(captured.queue, 'old').get('state')).toBe('skipped');
    expect(state(captured.queue, 'old').get('last_error')).toBe('superseded by inventory tip');
    for (const id of ['keep', 'live', 'other'])
      expect(state(captured.queue, id).get('state')).toBe('pending');
    expect(result.retired).toEqual([{ id: 'old', at: '2026-01-01T00:00:00Z' }]);
    expect(state(queue, 'old').get('state')).toBe('pending');
  });
  it('retires a current-pin job that is past the age bound as expired', async () => {
    const f = fixture();
    keepItems(f);
    f.effects.now = () => '2026-01-03T00:00:00Z';
    const result = await prepareInventory(
      queueOf(row('stale', '"target":"tip"')),
      true,
      f.effects,
      {
        retire: true,
      },
    );
    expect(state(result.queue, 'stale').get('last_error')).toBe('expired: pending more than 24 h');
    expect(result.retired).toEqual([{ id: 'stale', at: '2026-01-03T00:00:00Z' }]);
  });
  it('applies neither rule without options, and never retires in report-only mode', async () => {
    const f = fixture();
    keepItems(f);
    const queue = queueOf(row('old', '"target":"older"'));
    const plain = await prepareInventory(queue, true, f.effects);
    expect(plain.retired).toBeUndefined();
    expect(state(plain.queue, 'old').get('state')).toBe('pending');
    const reportOnly = await prepareInventory(queue, false, f.effects, { retire: true });
    expect(reportOnly.retired).toBeUndefined();
  });
  it('stops enqueueing at the limit, counting pending jobs already at the target', async () => {
    const f = fixture();
    mocks.replay.mockResolvedValue({
      candidates: [{ prs: [7] }, { prs: [7] }, { prs: [7] }],
      paths: [],
    });
    mocks.construct.mockResolvedValue({ partitions: [{ kind: 'path', tier: 'high' }], debt: [] });
    let n = 0;
    f.effects.enqueue = (queue, _partition) => {
      const item = doc(
        `{"id":"new${String(n++)}","state":"pending","target":"tip","kind":"backfill"}`,
      );
      const rows = queue.get('items') as JsonObject[];
      return { queue: withObjectKeys(queue, [['items', [...rows, item]]]), item };
    };
    const seeded = queueOf(row('p1', '"target":"tip"'));
    const result = await prepareInventory(seeded, true, f.effects, { enqueueLimit: 3 });
    expect(result.eventItems).toEqual(['new0', 'new1']);
    const uncapped = await prepareInventory(seeded, true, f.effects);
    expect(uncapped.eventItems).toHaveLength(3);
  });
  it('does not count a deduplicated or non-pending enqueue toward the limit', async () => {
    const f = fixture();
    mocks.replay.mockResolvedValue({
      candidates: [{ prs: [7] }, { prs: [7] }, { prs: [7] }],
      paths: [],
    });
    mocks.construct.mockResolvedValue({ partitions: [{ kind: 'path', tier: 'high' }], debt: [] });
    // Every enqueue returns an existing item and leaves the queue unchanged.
    f.effects.enqueue = (queue) => ({
      queue,
      item: doc('{"id":"dup","state":"pending","target":"tip"}'),
    });
    const result = await prepareInventory(queueOf(), true, f.effects, { enqueueLimit: 1 });
    expect(result.eventItems).toEqual(['dup', 'dup', 'dup']);
  });
});
