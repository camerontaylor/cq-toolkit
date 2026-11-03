// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { afterEach, describe, expect, test } from 'vitest';
import { PR_SNAPSHOT_QUERY } from '../../src/selfhost/merge-recheck.js';
import { runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  HEAD,
  RecordingMergeEffects,
  StateForge,
  T0,
  cfg,
  cleanupTmpRoots,
  forgeGh,
  isStateBranchCall,
  tmpJournalRoot,
} from './self-merge-prs-recheck.helpers.js';

afterEach(cleanupTmpRoots);

describe('runSelfMergePrs — merge-time recheck through the real registry', () => {
  test('the dry run makes NO state-branch calls', async () => {
    const forge = new StateForge();
    const calls: string[][] = [];
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], calls),
        mergeEffects: new RecordingMergeEffects(),
        nowMs: () => T0,
      },
      { ...cfg(tmpJournalRoot()), dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(isStateBranchCall)).toEqual([]);
    expect(calls.some((args) => args[0] === 'api' && args[1] === 'user')).toBe(false);
    expect(calls.some((args) => args.includes(`query=${PR_SNAPSHOT_QUERY}`))).toBe(false);
    expect(forge.tip).toBeNull();
  });
});
