import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { CrqRecord } from '../../../src/policy/crq/receiptIdentity.js';
import {
  backgroundTurn,
  depsMet,
  hasCollectableRuns,
  inflight,
  itemRepo,
  launchBand,
  liveItems,
  optionalWait,
  parkedMergedLinkedReceipt,
  rank,
  sortKey,
  startsLastHour,
  type ScheduleContext,
} from '../../../src/policy/crq/tickSchedule.js';
import { parseUtc } from '../../../src/policy/crq/utc.js';

/**
 * Differential replay of the scheduling vectors emitted by
 * `apps/crq-python/vector_emit.py`. The Python oracle binds `crq.REPO`,
 * `crq.REPOS` and `crq.now()` for each row; the same bindings arrive as
 * vector input here, so both sides rank and pace the identical document.
 */

interface ScheduleInput {
  readonly primary_repo: string;
  readonly repos: { repo: string; rank_tier: number }[];
  readonly local_review_aging_minutes: number;
  readonly now: string;
  readonly queue: CrqRecord;
  readonly item: CrqRecord;
}

interface VectorCase {
  readonly name: string;
  readonly source: string;
  readonly input: ScheduleInput;
  readonly expect: { ok: true; value: unknown } | { ok: false; error: string; message?: string };
}

interface Family {
  readonly schema: string;
  readonly family: string;
  readonly cases: VectorCase[];
}

function loadFamily(family: string): Family {
  return JSON.parse(
    readFileSync(
      new URL(`../../../apps/crq-python/fixtures/group-p/${family}.json`, import.meta.url),
      'utf8',
    ),
  ) as Family;
}

function contextOf(input: ScheduleInput): ScheduleContext {
  const now = parseUtc(input.now);
  if (now === null) throw new Error(`vector now is not a timestamp: ${input.now}`);
  return {
    config: {
      primaryRepo: input.primary_repo,
      repos: input.repos,
      localReviewAgingMinutes: input.local_review_aging_minutes,
    },
    nowMicros: now.epochMicros,
  };
}

function replay(source: string, input: ScheduleInput): unknown {
  const context = contextOf(input);
  switch (source) {
    case 'crq.rank':
      return rank(input.item, context);
    case 'crq.sort_key':
      return [...sortKey(input.item, context)];
    case 'crq.launch_band':
      return launchBand(input.item, context);
    case 'crq.deps_met':
      return depsMet(input.queue, input.item);
    case 'crq.optional_wait':
      return optionalWait(input.queue, input.item, context);
    case 'crq.parked_merged_linked_receipt':
      return parkedMergedLinkedReceipt(input.queue, input.item);
    case 'crq.inflight':
      return inflight(input.queue).map((item) => item.id);
    case 'crq.has_collectable_runs':
      return hasCollectableRuns(input.queue);
    case 'crq.background_turn':
      return backgroundTurn(input.queue);
    case 'crq.starts_last_hour':
      return startsLastHour(input.queue, context.nowMicros);
    case 'crq.item_repo':
      return itemRepo(input.item, input.primary_repo);
    case 'crq.live_items':
      return { live_ids: liveItems(input.queue).map((item) => item.id) };
    default:
      throw new Error(`no replay for ${source}`);
  }
}

describe.each(loadFamily('tick-schedule').cases)('tick-schedule/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    expect(vector.expect.ok).toBe(true);
    if (!vector.expect.ok) return;
    expect(replay(vector.source, vector.input)).toEqual(vector.expect.value);
  });
});

describe.each(loadFamily('promotion-filter').cases)('promotion-filter/$name', (vector) => {
  test('historical promotion records never become live scheduling work', () => {
    expect(vector.expect.ok).toBe(true);
    if (!vector.expect.ok) return;
    const queue = vector.input.queue as CrqRecord;
    expect({ live_ids: liveItems(queue).map((item) => item.id) }).toEqual(vector.expect.value);
  });
});
