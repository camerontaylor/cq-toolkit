// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { describe, expect, test } from 'vitest';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
import { recheckedRegistryView } from '../../src/selfhost/self-merge-prs.js';
import { RecordingMergeEffects } from './self-merge-prs-recheck.helpers.js';

describe('recheckedRegistryView', () => {
  const entry = (name: string): OpRegistryEntry<never, never> =>
    ({
      name,
      inputSchema: {},
      importer: async () => async () => ({ status: 'ok', value: name }),
    }) as unknown as OpRegistryEntry<never, never>;
  const neverRecheck = async (): Promise<{ ok: false; reason: string }> => ({
    ok: false,
    reason: 'unused',
  });

  test('non-merge entries pass through identical; merge.runPrs keeps name + schema, swaps the importer', () => {
    const other = entry('review.fetch');
    const merge = entry('merge.runPrs');
    const base: OpRegistryView = {
      get: (name) =>
        name === 'review.fetch' ? other : name === 'merge.runPrs' ? merge : undefined,
    };
    const view = recheckedRegistryView({
      baseView: base,
      innerEffects: new RecordingMergeEffects(),
      recheck: neverRecheck,
    });
    expect(view.get('review.fetch')).toBe(other);
    expect(view.get('nope')).toBeUndefined();
    const gated = view.get('merge.runPrs');
    expect(gated?.name).toBe('merge.runPrs');
    expect(gated?.inputSchema).toBe(merge.inputSchema);
    expect(gated?.importer).not.toBe(merge.importer);
  });

  test('a missing merge.runPrs stays undefined (never fabricated)', () => {
    const view = recheckedRegistryView({
      baseView: { get: () => undefined },
      innerEffects: new RecordingMergeEffects(),
      recheck: neverRecheck,
    });
    expect(view.get('merge.runPrs')).toBeUndefined();
  });
});
