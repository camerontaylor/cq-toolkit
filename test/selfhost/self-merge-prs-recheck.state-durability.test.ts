// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { rmSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../src/ops/merge/classify.config.js';
import { parseSettleState } from '../../src/policy/queue/settle-state.js';
import { runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  HEAD,
  REPO_PATH,
  RecordingMergeEffects,
  StateForge,
  T0,
  cfg,
  cleanupTmpRoots,
  forgeGh,
  iso,
  tmpJournalRoot,
} from './self-merge-prs-recheck.helpers.js';

afterEach(cleanupTmpRoots);

describe('runSelfMergePrs — merge-time recheck through the real registry', () => {
  test('state branch round-trip survives a simulated Actions-cache eviction', async () => {
    const forge = new StateForge(); // no cq-state branch yet: the first run bootstraps it
    const fixtures = [
      { pr: 7, approvedOid: HEAD(7) },
      { pr: 8, approvedOid: HEAD(8) },
    ];

    // Run 1: the observation pass writes BOTH open candidates in ONE commit;
    // the recheck refuses (a single instant is not a settle).
    const journal1 = tmpJournalRoot();
    const effects1 = new RecordingMergeEffects();
    const first = await runSelfMergePrs(
      { gh: forgeGh(forge, fixtures, []), mergeEffects: effects1, nowMs: () => T0 },
      cfg(journal1),
    );
    if (first.dryRun === true) throw new Error('unreachable');
    expect(first.settleObservation.observed).toEqual([7, 8]);
    expect(first.settleObservation.write?.ok).toBe(true);
    const observeCommit = forge.written()[0];
    expect(observeCommit?.message).toBe('settle: observe 2 open pr(s)');
    expect(observeCommit?.parent).toBeNull(); // the bootstrap root commit
    const observed = parseSettleState(
      JSON.parse(observeCommit?.content ?? '{}') as unknown,
      REPO_PATH,
    );
    expect(Object.keys(observed.state.prs)).toEqual(['7', '8']);
    expect(effects1.merges).toEqual([]);

    // The Actions cache is evicted: the first run's journal root is gone
    // and run 2 starts from a FRESH, EMPTY root.
    rmSync(journal1, { recursive: true, force: true });
    const journal2 = tmpJournalRoot();

    // Run 2, past the settle window: the state branch still carries run 1's
    // observation, so both PRs merge.
    const effects2 = new RecordingMergeEffects();
    const second = await runSelfMergePrs(
      {
        gh: forgeGh(forge, fixtures, []),
        mergeEffects: effects2,
        nowMs: () => T0 + REVIEW_ACCEPT_SETTLE_MS + 60_000,
      },
      cfg(journal2),
    );
    if (second.dryRun === true) throw new Error('unreachable');
    expect(effects2.merges).toEqual([
      { pr: 7, matchHeadCommit: HEAD(7) },
      { pr: 8, matchHeadCommit: HEAD(8) },
    ]);
    expect(second.outcome?.needsHuman).toEqual([]);
    expect(forge.state().prs['7']?.observations[0]?.observedAt).toBe(iso(T0));
  });
});
