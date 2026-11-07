// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { afterEach, describe, expect, test } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../src/ops/merge/classify.config.js';
import { runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  HEAD,
  RecordingMergeEffects,
  StateForge,
  T0,
  cfg,
  cleanupTmpRoots,
  forgeGh,
  seededState,
  tmpJournalRoot,
} from './self-merge-prs-recheck.helpers.js';

afterEach(cleanupTmpRoots);

describe('runSelfMergePrs — merge-time recheck through the real registry', () => {
  test('the configured main pass merges an exact-head reviewed main PR', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects('main');
    await runSelfMergePrs(
      {
        gh: forgeGh(
          forge,
          [{ pr: 7, approvedOid: HEAD(7), liveBaseName: 'main', baseName: 'main' }],
          [],
        ),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      { ...cfg(tmpJournalRoot()), baseBranch: 'main' },
    );
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
  });

  test('protected=release with base=main: a PR whose live base is release is refused by the protected-branch guard', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects('main');
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(
          forge,
          [{ pr: 7, approvedOid: HEAD(7), liveBaseName: 'release', baseName: 'main' }],
          [],
        ),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      {
        ...cfg(tmpJournalRoot()),
        baseBranch: 'main',
        cqEnv: readCqEnv({ CQ_MERGE_PROTECTED_BRANCH: 'release' }),
      },
    );
    expect(effects.merges).toEqual([]);
    expect(JSON.stringify(result)).toContain('protected branch release');
  });
});
