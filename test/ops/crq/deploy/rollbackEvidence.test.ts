import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../../src/policy/crq/jsonValue.js';
import {
  compatibilityReason,
  measureCqBin,
  Refused,
  type CqBinEffects,
} from '../../../../src/ops/crq/deploy/rollbackEvidence.js';

const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const object = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
function fx(file: { sha256: string; mode: number; resolved: string } | null) {
  const seen: string[] = [];
  const effects: CqBinEffects = {
    inspectFile: async (p) => (seen.push(p), file),
  };
  return { effects, seen };
}
describe('measureCqBin', () => {
  test('measures the entry: sha, octal mode and resolved path', async () => {
    const f = fx({ sha256: 'ab'.repeat(32), mode: 0o100755, resolved: '/real/cq' });
    const r = await measureCqBin(bytes({ repair: { cq_bin: '/opt/cq' } }), f.effects);
    expect(r).toEqual({
      pointer: '/opt/cq',
      placeholder: false,
      exists: true,
      sha256: 'ab'.repeat(32),
      mode: '0o755',
      resolved: '/real/cq',
    });
    expect(f.seen).toEqual(['/opt/cq']);
  });
  test('a placeholder is recorded as such and never inspected', async () => {
    const f = fx(null);
    const r = await measureCqBin(bytes({ repair: { cq_bin: 'x/@HOST_CQ_BIN@' } }), f.effects);
    expect(r).toMatchObject({ placeholder: true, exists: false, sha256: null });
    expect(f.seen).toEqual([]);
  });
  test('a missing entry records exists=false', async () => {
    const r = await measureCqBin(bytes({ repair: { cq_bin: '/gone' } }), fx(null).effects);
    expect(r).toMatchObject({ pointer: '/gone', exists: false, mode: null });
  });
  test('refuses an unknown, empty, relative or non-string pointer and bad JSON', async () => {
    const e = fx(null).effects;
    for (const cfg of [{}, { repair: {} }, { repair: { cq_bin: '' } }, { repair: { cq_bin: 7 } }])
      await expect(measureCqBin(bytes(cfg), e)).rejects.toThrow('no repair.cq_bin pointer');
    await expect(measureCqBin(bytes({ repair: { cq_bin: 'rel/cq' } }), e)).rejects.toThrow(
      "not an absolute path: 'rel/cq'",
    );
    await expect(measureCqBin(new TextEncoder().encode('{'), e)).rejects.toBeInstanceOf(Refused);
  });
});
describe('compatibilityReason', () => {
  test('names each denial exactly', () => {
    expect(compatibilityReason(null)).toBe('the compatibility record was not checked');
    expect(compatibilityReason(object({ checked: false }))).toBe(
      'the compatibility record was not checked',
    );
    expect(
      compatibilityReason(
        object({ checked: true, schema_marker_present: true, queue_schema: 'unreadable: EIO' }),
      ),
    ).toBe('the state queue could not be read (EIO)');
    expect(
      compatibilityReason(
        object({ checked: true, schema_marker_present: true, queue_schema: 'v2' }),
      ),
    ).toBe(
      "the queue carries an explicit schema marker ('v2') the prior target was never proven to read",
    );
    expect(
      compatibilityReason(
        object({ checked: true, schema_marker_present: false, schema_observations: ['a', 'b'] }),
      ),
    ).toBe('the queue carries state keys the prior target was never proven to read: a, b');
    expect(compatibilityReason(object({ checked: true, schema_marker_present: false }))).toBe(
      'the compatibility record is not the clean shape',
    );
  });
});
