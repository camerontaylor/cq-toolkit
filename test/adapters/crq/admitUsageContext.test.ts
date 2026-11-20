import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bindAdmit } from '../../../src/adapters/crq/admitWiring.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError, LedgerTypeError } from '../../../src/policy/crq/ledger.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import type { VendorUsage } from '../../../src/policy/crq/usageSlots.js';
import { parseUtc } from '../../../src/policy/crq/utc.js';

/**
 * Differential replay of `usage-context.json`. The Python oracle is
 * `crq.admit_available` with its launch loop stubbed and the real
 * `backfill_runtime.usage_context` left in, so the expected queue carries what
 * Python wrote before the gate: `usage`, `backfill_usage`, the (possibly
 * expired) reservations, `backfill_starts_at_observation` and the key order.
 */

interface UsageContextInput {
  readonly queue: unknown;
  readonly usage: VendorUsage | null;
  readonly reserved: unknown[];
  readonly max_starts_per_hour: number;
  readonly max_starts_per_tick: number;
  readonly max_inflight: number;
  readonly now: string;
}

interface UsageContextValue {
  readonly gate: string | null;
  readonly remaining: number;
  readonly start_attempts: number;
  readonly log: string[];
  readonly starts: number;
  readonly usage: unknown;
  readonly backfill_starts_at_observation: number;
  readonly backfill_usage: unknown;
  readonly backfill_reservations: unknown;
  readonly queue_keys: string[];
}

interface VectorCase {
  readonly name: string;
  readonly input: UsageContextInput;
  readonly expect:
    | { readonly ok: true; readonly value: UsageContextValue }
    | { readonly ok: false; readonly error: string; readonly message: string };
}

const document = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/group-p/usage-context.json', import.meta.url),
    'utf8',
  ),
) as { cases: VectorCase[] };

const STAMP = '2026-11-14T00:00:00Z';

/** Bind the vector to `bindAdmit` with Python's stub: one appended start per launch. */
async function replay(input: UsageContextInput) {
  const now = parseUtc(input.now);
  if (now === null) throw new Error(`vector now is not a timestamp: ${input.now}`);
  let attempts = 0;
  const admit = bindAdmit({
    config: {
      maxStartsPerHour: input.max_starts_per_hour,
      maxStartsPerTick: input.max_starts_per_tick,
      maxInflight: input.max_inflight,
    },
    nowMicros: () => now.epochMicros,
    startOne: async (queue) => {
      attempts++;
      const starts = queue.get('starts');
      return {
        queue: withObjectKeys(queue, [
          ['starts', [...(Array.isArray(starts) ? starts : []), STAMP]],
        ]),
        log: [],
        hasCoverage: false,
      };
    },
  });
  // The probe seeds `starts` before the call, so the key order starts there.
  const seeded = parseJsonValue(JSON.stringify(input.queue)) as JsonObject;
  const queue = seeded.has('starts') ? seeded : withObjectKeys(seeded, [['starts', []]]);
  const out = await admit(queue, {
    usage: input.usage,
    reserved: input.reserved.map((startedAt) => ({ itemIndex: -1, runId: null, startedAt })),
    log: [],
    dry: false,
    only: null,
    ignoreQuiet: false,
  } as unknown as Parameters<typeof admit>[1]);
  return { out, attempts };
}

const plain = (queue: JsonObject, key: string): unknown => {
  const value = queue.get(key);
  return value === undefined ? null : toPlainJson(value);
};

describe.each(document.cases)('usage-context/$name', (vector) => {
  test('the bound queue, gate and budget match the Python oracle', async () => {
    const expected = vector.expect;
    if (!expected.ok) {
      const error = await replay(vector.input).then(
        () => null,
        (e: unknown) => e,
      );
      // Python raises before the gate and before any launch, never a quiet default.
      expect(error).toBeInstanceOf(Error);
      if (expected.error === 'IntegrityError') {
        expect(error).toBeInstanceOf(LedgerIntegrityError);
        expect((error as Error).message).toBe(expected.message);
      } else {
        expect(error).toBeInstanceOf(LedgerTypeError);
      }
      return;
    }
    const { out, attempts } = await replay(vector.input);
    const want = expected.value;
    expect(out.globalGate).toBe(want.gate);
    expect(out.remaining).toBe(want.remaining);
    expect(attempts).toBe(want.start_attempts);
    expect(out.log).toEqual(want.log);
    expect((out.queue.get('starts') as unknown[]).length).toBe(want.starts);
    expect(plain(out.queue, 'usage')).toEqual(want.usage);
    expect(plain(out.queue, 'backfill_starts_at_observation')).toBe(
      want.backfill_starts_at_observation,
    );
    expect(plain(out.queue, 'backfill_usage')).toEqual(want.backfill_usage);
    expect(plain(out.queue, 'backfill_reservations')).toEqual(want.backfill_reservations);
    expect(out.queue.entries.map(([key]) => key)).toEqual(want.queue_keys);
  });
});

describe('usage context wiring', () => {
  const NOW = 1_800_000_000_000_000n;
  const env = (over: { nowMicros?: () => bigint } = {}) => ({
    config: { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 },
    nowMicros: over.nowMicros ?? (() => NOW),
    startOne: async (queue: JsonObject) => ({ queue, log: [], hasCoverage: false }),
  });
  const request = (usage: unknown, reserved: unknown[] = [], dry = false) =>
    ({ usage, reserved, log: [], dry, only: null, ignoreQuiet: false }) as unknown as Parameters<
      ReturnType<typeof bindAdmit>
    >[1];
  const queue = () => parseJsonValue('{"items":[],"starts":[]}') as JsonObject;

  test('a dry run still records the observation', async () => {
    const out = await bindAdmit(env())(queue(), request({ remaining: 3 }, [], true));
    expect(plain(out.queue, 'backfill_usage')).toMatchObject({ successful: true, remaining: 3 });
    expect(plain(out.queue, 'backfill_starts_at_observation')).toBe(0);
  });

  test('observed_at is the whole-second UTC of the single clock read', async () => {
    let reads = 0;
    const out = await bindAdmit(
      env({
        nowMicros: () => {
          reads++;
          return NOW + 999_999n;
        },
      }),
    )(queue(), request({ remaining: 3 }));
    expect(reads).toBe(1);
    expect((out.queue.get('backfill_usage') as JsonObject).get('observed_at')).toBe(
      '2027-01-15T08:00:00Z',
    );
  });

  test('an undated hold lowers the remaining count like Python None stamps', async () => {
    const out = await bindAdmit(env())(
      queue(),
      request({ remaining: 3 }, [
        { itemIndex: 0, runId: null, startedAt: undefined },
        { itemIndex: 1, runId: null, startedAt: '2027-01-15T07:00:00Z' },
      ]),
    );
    expect(plain(out.queue, 'backfill_usage')).toMatchObject({ remaining: 1 });
  });

  test('an unavailable probe is an unsuccessful zero observation and records usage null', async () => {
    const out = await bindAdmit(env())(queue(), request(null));
    expect(plain(out.queue, 'backfill_usage')).toMatchObject({ successful: false, remaining: 0 });
    expect(out.queue.get('usage')).toBeNull();
  });

  test('the caller queue is not mutated', async () => {
    const input = queue();
    const before = JSON.stringify(toPlainJson(input));
    await bindAdmit(env())(input, request({ remaining: 3 }));
    expect(JSON.stringify(toPlainJson(input))).toBe(before);
  });
});
