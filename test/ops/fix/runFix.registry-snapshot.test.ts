// Issue #1185: the registered fix.run importer must bind the dispatch
// wiring's CqEnv snapshot to the composition, so a direct importer call with
// explicit wiring outside a run cannot let captureProvenance fall back to the
// ambient environment. The composition itself is stubbed: this file pins the
// WIRING, while runFix.provenance-snapshot.test.ts drives the real runtime.
import { describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import * as runFixModule from '../../../src/ops/fix/runFix.js';
import { registry } from '../../../src/ops/fix/registry.js';

const entryOf = () => {
  const entry = registry.find((candidate) => candidate.name === 'fix.run');
  if (entry === undefined) throw new Error('fix family: no registry entry named fix.run');
  return entry;
};

const stubComposition = (seen: unknown[]) =>
  vi.spyOn(runFixModule, 'makeFixRun').mockImplementation(((deps: unknown) => {
    seen.push(deps);
    return async () => ({ status: 'failed' as const, error: 'stubbed composition' });
  }) as typeof runFixModule.makeFixRun);

describe('fix.run registry snapshot wiring (issue #1185)', () => {
  test('the importer binds wiring.cqEnv to the composition', async () => {
    const seen: unknown[] = [];
    const spy = stubComposition(seen);
    try {
      const cqEnv = readCqEnv({ CQ_WORK_ID: '11111111-1111-4111-8111-111111111111' });
      const op = await entryOf().importer({ cqEnv });
      await op({} as never);
      expect(seen).toHaveLength(1);
      expect((seen[0] as { cqEnv?: unknown }).cqEnv).toBe(cqEnv);
    } finally {
      spy.mockRestore();
    }
  });

  test('an unwired importer binds no cqEnv key (library default)', async () => {
    const seen: unknown[] = [];
    const spy = stubComposition(seen);
    try {
      const op = await entryOf().importer();
      await op({} as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty('cqEnv');
    } finally {
      spy.mockRestore();
    }
  });
});
