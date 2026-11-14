import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  canonicalFixedEvents,
  type CanonicalFixedEventsEffects,
  type CanonicalFixedEventsInput,
} from '../../../src/ops/crq/internal/canonicalFixedEvents.js';

const fid = 'f'.repeat(64),
  published = 'b'.repeat(40),
  actual = 'c'.repeat(40),
  merge = 'a'.repeat(40);
function object(value: unknown): JsonObject {
  const v = parseJsonValue(JSON.stringify(value));
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
function fixture(): {
  input: CanonicalFixedEventsInput;
  effects: CanonicalFixedEventsEffects;
  calls: string[];
} {
  const calls: string[] = [];
  const input: CanonicalFixedEventsInput = {
    fixedJobs: ['crq-j1'],
    recordJobs: ['crq-j1'],
    publishedHead: published,
    fixPrNumber: object({ n: 42 }).get('n')!,
    pr: object({ number: 42, headRefOid: actual, mergeCommit: { oid: merge } }),
  };
  const effects: CanonicalFixedEventsEffects = {
    readJob: async (id) => object({ job: id, canonical_finding_id: fid }),
    triageExists: async () => true,
    currentFixedEvent: async (_job, m) => {
      calls.push(`event:${m}`);
      return 'ev-1';
    },
    isAncestor: async (a, d) => {
      calls.push(`anc:${a}:${d}`);
      return true;
    },
  };
  return { input, effects, calls };
}

describe('canonical fixed events projection', () => {
  test('projects the current event of every FIXED job at the merge commit', async () => {
    const { input, effects, calls } = fixture();
    const result = await canonicalFixedEvents(input, effects);
    expect(result?.publishedHead).toBe(published);
    expect(result?.actualHead).toBe(actual);
    expect([...result!.events]).toEqual([['crq-j1', 'ev-1']]);
    expect(calls).toEqual([`event:${merge}`, `anc:${published}:${actual}`]);
  });
  test('is null with no FIXED job, a missing triage row, or a non-current event', async () => {
    const a = fixture();
    expect(await canonicalFixedEvents({ ...a.input, fixedJobs: [] }, a.effects)).toBeNull();
    const b = fixture();
    b.effects.triageExists = async () => false;
    expect(await canonicalFixedEvents(b.input, b.effects)).toBeNull();
    const c = fixture();
    c.effects.readJob = async (id) => object({ job: id, canonical_finding_id: 'short' });
    expect(await canonicalFixedEvents(c.input, c.effects)).toBeNull();
    const d = fixture();
    d.effects.currentFixedEvent = async () => null;
    expect(await canonicalFixedEvents(d.input, d.effects)).toBeNull();
    expect(d.calls).not.toContain(`anc:${published}:${actual}`);
  });
  test('refuses a stale job identity binding', async () => {
    const a = fixture();
    a.effects.readJob = async () => object({ job: 'crq-other', canonical_finding_id: fid });
    await expect(canonicalFixedEvents(a.input, a.effects)).rejects.toThrow('job identity mismatch');
    const b = fixture();
    await expect(
      canonicalFixedEvents({ ...b.input, recordJobs: ['crq-other'] }, b.effects),
    ).rejects.toThrow('job identity mismatch');
  });
  test('refuses stale PR lineage: number, missing head, or non-ancestor', async () => {
    const a = fixture();
    await expect(
      canonicalFixedEvents(
        { ...a.input, pr: object({ number: 43, headRefOid: actual }) },
        a.effects,
      ),
    ).rejects.toThrow('lineage mismatch');
    const b = fixture();
    await expect(
      canonicalFixedEvents({ ...b.input, publishedHead: undefined }, b.effects),
    ).rejects.toThrow('lineage mismatch');
    const c = fixture();
    await expect(
      canonicalFixedEvents({ ...c.input, pr: object({ number: 42 }) }, c.effects),
    ).rejects.toThrow('lineage mismatch');
    const d = fixture();
    d.effects.isAncestor = async () => false;
    await expect(canonicalFixedEvents(d.input, d.effects)).rejects.toThrow('lineage mismatch');
  });
});
