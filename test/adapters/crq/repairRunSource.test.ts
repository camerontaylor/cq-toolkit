import { describe, expect, it } from 'vitest';
import { fileRepairRunOptions } from '../../../src/adapters/crq/repairRunSource.js';

describe('fileRepairRunOptions', () => {
  it('carries resume through and resolves the central registry fixFinding op', async () => {
    const fresh = await fileRepairRunOptions({ resume: false });
    expect(fresh.resume).toBe(false);
    expect(fresh.registry.get('review.fixFinding')?.name).toBe('review.fixFinding');
    expect(fresh.registry.get('no.such.op')).toBeUndefined();
    expect((await fileRepairRunOptions({ resume: true })).resume).toBe(true);
  });

  it('looks entries up by exact name from the injected list', async () => {
    const entry = { name: 'review.fixFinding' } as never;
    const opts = await fileRepairRunOptions({ resume: false, entries: async () => [entry] });
    expect(opts.registry.get('review.fixFinding')).toBe(entry);
    expect(opts.registry.get('review.fixfinding')).toBeUndefined();
  });
});
