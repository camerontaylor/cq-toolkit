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
