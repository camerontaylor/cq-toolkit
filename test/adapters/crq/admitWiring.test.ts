import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import {
  bindAdmit,
  type AdmitEnv,
  type StartOneResult,
} from '../../../src/adapters/crq/admitWiring.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const CONFIG = { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 };
const NOW = 1_800_000_000_000_000n;
const usage = (remaining: number) => ({ remaining });

function make(
  over: Partial<AdmitEnv> = {},
  startOne?: (q: JsonObject, n: number) => StartOneResult,
): { admit: ReturnType<typeof bindAdmit>; calls: number[] } {
  const calls: number[] = [];
  const env: AdmitEnv = {
    config: CONFIG,
    nowMicros: () => NOW,
    startOne: async (q) => {
      calls.push(calls.length);
      return (
        startOne?.(q, calls.length) ?? {
          queue: doc({
            ...(toPlainJson(q) as object),
            starts: [
              ...((toPlainJson(q) as { starts?: unknown[] }).starts ?? []),
              '2027-01-15T07:59:00Z',
            ],
          }),
          log: [`started ${calls.length}`],
          hasCoverage: calls.length === 1,
        }
      );
    },
    ...over,
  };
  return { admit: bindAdmit(env), calls };
}
const request = (u: unknown, over: Record<string, unknown> = {}) => ({
  usage: u,
  reserved: [],
  log: [],
  dry: false,
  only: null,
  ignoreQuiet: false,
  ...over,
});
const base = () => doc({ items: [], starts: [] });

describe('bindAdmit', () => {
  it('launches up to the slot budget and reports what remains', async () => {
    const { admit, calls } = make();
    const out = await admit(base(), request(usage(2)));
    expect(calls).toHaveLength(2);
    expect(out.globalGate).toBeNull();
    expect(out.remaining).toBe(0);
    expect(out.hasCoverage).toBe(true);
    expect((out.queue.get('starts') as unknown[]).length).toBe(2);
    expect(out.log).toEqual(['started 1', 'started 2']);
  });

  it('does not launch when the slot gate is closed and returns the gate line', async () => {
    const { admit, calls } = make();
    const out = await admit(base(), request(usage(0)));
    expect(calls).toHaveLength(0);
    expect(out.globalGate).toBe('slots');
    expect(out.log.length).toBeGreaterThan(0);
  });

  it('stops after one start for a dry run and for --only', async () => {
    for (const over of [{ dry: true }, { only: 'item-1' }]) {
      const { admit, calls } = make();
      await admit(base(), request(usage(5), over));
      expect(calls).toHaveLength(1);
    }
  });

  it('treats an empty only as no restriction', async () => {
    const { admit, calls } = make();
    await admit(base(), request(usage(3), { only: '' }));
    expect(calls).toHaveLength(3);
  });

  it('stops when a start reserves nothing', async () => {
    const { admit, calls } = make({}, (q) => ({ queue: q, log: [], hasCoverage: false }));
    const out = await admit(base(), request(usage(4)));
    expect(calls).toHaveLength(1);
    expect(out.remaining).toBe(4);
  });

  it('stops at max in-flight, counting reviewing items live', async () => {
    const { admit, calls } = make({ config: { ...CONFIG, maxInflight: 2 } }, (q) => {
      const plain = toPlainJson(q) as { items: unknown[]; starts: unknown[] };
      const n = plain.items.length;
      const add = (i: number) => ({ id: `i${i}`, kind: 'open', state: 'reviewing' });
      return {
        queue: doc({
          items: [...plain.items, add(n), add(n + 1)],
          starts: [...plain.starts, '2027-01-15T07:59:00Z'],
        }),
        log: [],
        hasCoverage: false,
      };
    });
    const out = await admit(base(), request(usage(9)));
    expect(calls).toHaveLength(1);
    expect((out.queue.get('items') as unknown[]).length).toBe(2);
  });

  it('passes the dry, only and ignoreQuiet context to startOne', async () => {
    const seen: unknown[] = [];
    const { admit } = make({}, (q) => {
      return { queue: q, log: [], hasCoverage: false };
    });
    const spy = bindAdmit({
      config: CONFIG,
      nowMicros: () => NOW,
      startOne: async (q, ctx) => {
        seen.push(ctx);
        return { queue: q, log: [], hasCoverage: false };
      },
    });
    await spy(base(), request(usage(1), { only: 'z', ignoreQuiet: true, dry: true }));
    expect(seen).toEqual([{ dry: true, only: 'z', ignoreQuiet: true }]);
    expect(admit).toBeTypeOf('function');
  });

  it('uses the conservative start-log fallback when usage is unavailable', async () => {
    const { admit, calls } = make();
    const out = await admit(base(), request(null));
    expect(out.globalGate).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    const spent = doc({
      items: [],
      starts: Array.from({ length: 5 }, () => '2027-01-15T07:59:00Z'),
    });
    const none = make();
    const closed = await none.admit(spent, request(null));
    expect(closed.globalGate).toBe('slots');
    expect(none.calls).toHaveLength(0);
  });
});
