// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split into
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// plus self-merge-prs-recheck.helpers.ts (pure move).

import { afterEach, describe, expect, test } from 'vitest';
import type { GhResult } from '../../src/adapters/forge-github/gh.js';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../src/ops/merge/classify.config.js';
import { trustPolicyFromConfig } from '../../src/selfhost/merge-recheck.js';
import { runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  APPROVER,
  HEAD,
  RecordingMergeEffects,
  StateForge,
  T0,
  cfg,
  cleanupTmpRoots,
  forgeGh,
  json,
  seededState,
  tmpJournalRoot,
} from './self-merge-prs-recheck.helpers.js';

afterEach(cleanupTmpRoots);

describe('runSelfMergePrs — merge-time recheck through the real registry', () => {
  test("the automation identity's own head-bound approval never counts", async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        // The token IS the approver: its approval must be excluded.
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], json({ login: APPROVER })),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toEqual({ resolved: true, login: APPROVER });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('no_head_bound_acceptance');
  });

  test('an integration token (403 on /user) proceeds; the merge goes through', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const forbidden: GhResult = {
      code: 1,
      stdout: '',
      stderr: 'gh: Resource not accessible by integration (HTTP 403)',
    };
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], forbidden),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toMatchObject({
      resolved: false,
      reason: expect.stringContaining('integration token') as unknown,
    });
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
  });

  test('any other identity failure fails closed: every merge refused, the run still completes', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Bad credentials (HTTP 401)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toEqual({
      resolved: false,
      reason: 'gh exit 1: gh: Bad credentials (HTTP 401)',
    });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain(
      'automation identity unresolved: gh exit 1: gh: Bad credentials (HTTP 401)',
    );
  });

  test('an integration token with trustedBots configured fails closed (the App bot is unknowable)', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Resource not accessible by integration (HTTP 403)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      {
        ...cfg(tmpJournalRoot()),
        trustPolicy: trustPolicyFromConfig({ trustedBots: ['coderabbitai[bot]'] }),
      },
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('integration token with trustedBots configured');
  });

  test('a non-integration 403 fails closed like any other identity failure', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Must have admin rights to Repository. (HTTP 403)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toMatchObject({ resolved: false });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('automation identity unresolved');
  });
});
