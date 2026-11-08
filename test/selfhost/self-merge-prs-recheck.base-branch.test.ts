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

  test('run level: cfg.baseBranch omitted and a trunk snapshot reaches the gated op and merges', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects('trunk');
    await runSelfMergePrs(
      {
        gh: forgeGh(
          forge,
          [{ pr: 7, approvedOid: HEAD(7), liveBaseName: 'trunk', baseName: 'trunk' }],
          [],
        ),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      { ...cfg(tmpJournalRoot()), cqEnv: readCqEnv({ CQ_MERGE_BASE_BRANCH: 'trunk' }) },
    );
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
  });

  test('an invalid trust snapshot fails config before any gh call (fetch/observe not reached)', async () => {
    let ghCalls = 0;
    const err = await runSelfMergePrs(
      {
        gh: (async () => {
          ghCalls += 1;
          throw new Error('gh must not be called');
        }) as never,
        mergeEffects: new RecordingMergeEffects('main'),
        nowMs: () => T0,
      },
      {
        ...cfg(tmpJournalRoot()),
        cqEnv: readCqEnv({ CQ_MERGE_PROTECTED_BRANCH: 'release branch' }),
      },
    ).catch((e: unknown) => e);
    expect((err as { dispatchClass?: string }).dispatchClass).toBe('config');
    expect(ghCalls).toBe(0);
  });
});
