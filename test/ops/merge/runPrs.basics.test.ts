// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the basic pipeline shapes (happy path, dispatch trust policy,
// the DISMISSED boundary refusal) and the no-acted pass-2 seam guard.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { describe, expect, test } from 'vitest';
import { runMergePrs } from '../../../src/ops/merge/runPrs.js';
import { RunMergePrsInputSchema } from '../../../src/ops/merge/registry.js';
import {
  acted,
  approved,
  baseInput,
  eligible,
  FakeMergeEffects,
  fakeRefetch,
  fakeResolve,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('happy path, no conflicts: both eligible prs merge in pass 1; the agent never runs', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(999));
    const outcome = await runMergePrs(baseInput([eligible(44), eligible(45)]), {
      effects,
      resolve,
    });

    expect(outcome.firstPass.merged).toEqual([44, 45]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([]);
    // The post-mortem of the final (= first) report: nothing to do.
    expect(outcome.diagnosis.needsHuman).toEqual([]);
    expect(outcome.diagnosis.causes).toEqual([]);
    // The agent is never dispatched when nothing conflicts.
    expect(calls).toEqual([]);
  });

  test('dispatch config applies trust policy: coderabbit approval yields no acceptable review', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(999));
    const outcome = await runMergePrs(
      {
        ...baseInput([
          eligible(44, {
            reviews: [
              {
                ...approved(44),
                authorLogin: 'coderabbitai[bot]',
                authorAssociation: 'NONE',
              },
            ],
          }),
        ]),
        config: { trustedBots: [], trustedAssociations: [], automationLogin: 'cq-automation[bot]' },
      },
      { effects, resolve },
    );
    expect(outcome).not.toBeNull();
    // The composition surface reports the planner's stable not_eligible row;
    // the underlying F1 classification is the no_acceptable_review reason.
    expect(outcome.needsHuman).toEqual([{ pr: 44, reason: 'not_eligible' }]);
  });

  test('the dispatch boundary refuses DISMISSED in acceptReviewStates (review r3, PR #222)', () => {
    // A dismissed review is a retracted one — the doctrine holds DISMISSED
    // void, and the fold pre-filter already drops it under an active
    // policy, so admitting it at the boundary could only ever fire on the
    // legacy surface and diverge from the governed one (the selfhost
    // recheck's trust mapping refuses it the same way).
    const base = {
      baseBranch: 'main',
      repoRoot: '/tmp/whatever',
      prs: [],
    };
    const rejected = RunMergePrsInputSchema.safeParse({
      ...base,
      config: { acceptReviewStates: ['APPROVED', 'DISMISSED'] },
    });
    expect(rejected.success).toBe(false);
    // The verdict-carrying set parses clean.
    expect(
      RunMergePrsInputSchema.parse({ ...base, config: { acceptReviewStates: ['APPROVED'] } })
        .config,
    ).toEqual({ acceptReviewStates: ['APPROVED'] });
  });

  test('no acted resolution: the pass-2 refresh seam is never invoked even when wired', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(999));
    const { refetch, callCount } = fakeRefetch([]);
    const outcome = await runMergePrs(baseInput([eligible(44), eligible(45)]), {
      effects,
      resolve,
      refetch,
    });

    expect(outcome.firstPass.merged).toEqual([44, 45]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([]);
    // The post-mortem of the final (= first) report: nothing to do.
    expect(outcome.diagnosis.needsHuman).toEqual([]);
    expect(outcome.diagnosis.causes).toEqual([]);
    // The agent is never dispatched when nothing conflicts.
    expect(calls).toEqual([]);
    // And with no acted resolution the pass-2 refresh seam is never paid.
    expect(callCount()).toBe(0);
  });
});
