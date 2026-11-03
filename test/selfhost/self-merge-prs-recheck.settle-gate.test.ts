// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { afterEach, describe, expect, test } from 'vitest';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../src/ops/merge/classify.config.js';
import { runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  AUTOMATION_LOGIN,
  HEAD,
  OLD_SHA,
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
  test('an approval bound to an OLDER sha never merges: inner mergePr untouched, needsHuman carries the refusal', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - 2 * REVIEW_ACCEPT_SETTLE_MS));
    const effects = new RecordingMergeEffects();
    const calls: string[][] = [];
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: OLD_SHA }], calls),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('cq merge-time recheck refused pr 7');
    expect(row?.reason).toContain('no_head_bound_acceptance');
  });

  test('head-bound approval + a durable observation older than settle → the inner mergePr is called, pinned to the head', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], []),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
    expect(result.outcome?.firstPass.merged).toEqual([7]);
    expect(result.settleObservation.observed).toEqual([7]);
    // The tuple was already anchored: the run-start pass writes nothing,
    // and the ONLY commit is the recheck's pre-merge audit observation.
    expect(result.settleObservation.write).toBeNull();
    expect(forge.written().map((commit) => commit.message)).toEqual(['settle: recheck pr #7']);
    expect(result.automationIdentity).toEqual({ resolved: true, login: AUTOMATION_LOGIN });
  });

  test('a prior observation younger than settle → refused settle: settle_pending', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS / 2));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], []),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('cq merge-time recheck refused pr 7');
    expect(row?.reason).toContain('settle: settle_pending');
  });
});
