// Reviewer trust (bots, associations, accepted review states) and branch
// spellings are trust inputs resolved from config only (ADR-0009).
import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { errorClassOf } from '../../../src/driver/errors.js';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { registry } from '../../../src/ops/merge/registry.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
import { defaultClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';
import {
  assertBaseBranchMirror,
  resolveClassifyTrust,
} from '../../../src/ops/merge/trustMirrors.js';
import { buildRunInput } from '../../../src/selfhost/self-merge-prs.js';
import { eligible, FakeMergeEffects, NOW_MS } from './runPrs.helpers.js';

const env = (v: Record<string, string> = {}) => readCqEnv(v);
const entryOf = (name: string): OpRegistryEntry => registry.find((e) => e.name === name)!;
const candidate = eligible(1);
const EVIL = { trustedBots: ['evil[bot]'], acceptReviewStates: ['APPROVED', 'COMMENTED'] as const };

describe('classify trust inputs', () => {
  test('merge.classifyPrs: plan-chosen trust fields differing from config fail config, values not echoed', async () => {
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv: env() });
    for (const config of [
      { trustedBots: ['evil[bot]'] },
      { trustedAssociations: ['OWNER'] },
      { acceptReviewStates: ['COMMENTED'] },
    ]) {
      const err = await op({ candidate, nowMs: NOW_MS, config }).catch((e: unknown) => e);
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).toContain(`config.${Object.keys(config)[0]}`);
      expect(String(err)).not.toContain('evil');
      expect(String(err)).not.toContain('COMMENTED');
    }
  });

  test('the reproduction: bob APPROVED flips only via trusted config, never via plan data', async () => {
    const bobs = eligible(2, {
      reviews: [
        {
          id: 'r',
          authorLogin: 'bob',
          state: 'APPROVED',
          body: 'approving the cache changes',
          submittedAt: '2026-01-01T00:00:00.500Z',
        },
      ],
    });
    const classify = async (cqEnv: ReturnType<typeof env>, config?: object) => {
      const op = await entryOf('merge.classifyPrs').importer({ cqEnv });
      return (await op({ candidate: bobs, nowMs: NOW_MS, ...(config ? { config } : {}) })) as {
        status: string;
        value: { verdict: string };
      };
    };
    const trusted = await classify(env({ CQ_MERGE_TRUSTED_BOTS: 'bob' }));
    const untrusted = await classify(env({ CQ_MERGE_TRUSTED_BOTS: 'evil[bot]' }));
    expect(trusted.value.verdict).not.toBe(untrusted.value.verdict);
    // plan data cannot choose: a differing config fails, the same value passes
    await expect(
      classify(env({ CQ_MERGE_TRUSTED_BOTS: 'evil[bot]' }), { trustedBots: ['bob'] }),
    ).rejects.toThrow(/trust input/);
    expect(
      (await classify(env({ CQ_MERGE_TRUSTED_BOTS: 'bob' }), { trustedBots: ['bob'] })).value
        .verdict,
    ).toBe(trusted.value.verdict);
  });

  test('merge.runPrs (library op): differing trust fields fail before any effect; same passes', async () => {
    const effects = new FakeMergeEffects();
    const cqEnv = env({ CQ_MERGE_TRUSTED_BOTS: 'good[bot]' });
    const op = makeRunMergePrsOp({ effects, cqEnv });
    const base = { baseBranch: 'main', repoRoot: '.', prs: [], nowMs: NOW_MS };
    const err = await op({ ...base, config: EVIL }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).not.toContain('evil');
    expect(effects.calls).toEqual([]);
    expect((await op({ ...base, config: { trustedBots: ['good[bot]'] } })).status).toBe('ok');
    expect((await op(base)).status).toBe('ok');
  });

  test('plan dispatch route: a plan job carrying trust fields fails config, run-plan does not run it', async () => {
    const entry = entryOf('merge.classifyPrs');
    const report = await runPlan(
      {
        id: 'trust-classify',
        jobs: [
          {
            id: 'c',
            op: entry.name,
            input: { candidate, nowMs: NOW_MS, config: { trustedBots: ['evil[bot]'] } },
          },
        ],
      },
      { concurrency: 1, stopOnError: false, cqEnv: env() },
      { get: () => entry as unknown as OpRegistryEntry<never, never> },
    );
    expect(report.jobs[0]?.result.status).not.toBe('ok');
    expect(JSON.stringify(report.jobs[0]?.result)).not.toContain('evil');
  });

  test('self-host entry: the input builder carries only resolved trust, a differing cfg fails at the op', async () => {
    const cqEnv = env({ CQ_MERGE_TRUSTED_BOTS: 'good[bot]' });
    const input = buildRunInput(
      [],
      {
        repoRoot: '.',
        disableConflictResolution: true,
        cqEnv,
        classifyConfig: {
          ...(await import('../../../src/ops/merge/classify.config.js')).defaultClassifyPrConfig,
          trustedBots: ['good[bot]'],
        },
      },
      NOW_MS,
    );
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv });
    expect((await op(input)).status).toBe('ok');
    const bad = buildRunInput(
      [],
      {
        repoRoot: '.',
        disableConflictResolution: true,
        cqEnv,
        classifyConfig: {
          ...(await import('../../../src/ops/merge/classify.config.js')).defaultClassifyPrConfig,
          trustedBots: ['evil[bot]'],
        },
      },
      NOW_MS,
    );
    expect(errorClassOf(await op(bad).catch((e: unknown) => e))).toBe('config');
  });

  test('an invalid trust key snapshot is refused, not defaulted', async () => {
    const op = await entryOf('merge.classifyPrs').importer({
      cqEnv: env({ CQ_MERGE_TRUSTED_BOTS: 'not a login!' }),
    });
    expect(errorClassOf(await op({ candidate, nowMs: NOW_MS }).catch((e: unknown) => e))).toBe(
      'config',
    );
  });
});

describe('branch normalisation', () => {
  test('exactly one refs/heads/ is stripped; heads/x stays a literal branch', () => {
    const v = (raw: string) => env({ CQ_MERGE_BASE_BRANCH: raw }).values['CQ_MERGE_BASE_BRANCH'];
    expect(v('refs/heads/heads/trunk')).toBe('heads/trunk');
    expect(v('heads/trunk')).toBe('heads/trunk');
    expect(v('refs/heads/trunk')).toBe('trunk');
  });

  test('an accepted refs/heads base spelling reaches the planner normalised', async () => {
    const cqEnv = env();
    const plan = await entryOf('merge.planMergeOrder').importer({ cqEnv });
    const root = { ...eligible(1) };
    const planned = async (baseBranch: string) =>
      JSON.stringify(
        await plan({
          baseBranch,
          prs: [
            {
              pr: 1,
              headRefName: 'feat/1',
              baseRefName: 'main',
              state: 'open',
              authorLogin: root.authorLogin,
              classification: { verdict: 'eligible' },
              truncated: false,
            },
          ],
        }),
      ).replace('refs/heads/main', 'main');
    expect(await planned('refs/heads/main')).toBe(await planned('main'));
  });

  test('the mirror returns the normalised base (fails if normalisation is removed)', () => {
    const cqEnv = env();
    expect(assertBaseBranchMirror('t', 'refs/heads/main', cqEnv)).toBe('main');
    expect(assertBaseBranchMirror('t', 'main', cqEnv)).toBe('main');
    const heads = env({ CQ_MERGE_BASE_BRANCH: 'refs/heads/heads/trunk' });
    expect(assertBaseBranchMirror('t', 'refs/heads/heads/trunk', heads)).toBe('heads/trunk');
    expect(() => assertBaseBranchMirror('t', 'trunk', heads)).toThrow();
  });
});

describe('classify trust defaults are independent per key', () => {
  const MEMBER_OBJECTS = eligible(3, {
    reviews: [
      {
        id: 'bot',
        authorLogin: 'good[bot]',
        state: 'APPROVED',
        body: 'approving the cache changes',
        submittedAt: '2026-01-01T00:00:00.500Z',
      },
      {
        id: 'm',
        authorLogin: 'maintainer',
        state: 'CHANGES_REQUESTED',
        body: 'not yet',
        submittedAt: '2026-01-01T00:00:00.700Z',
        authorAssociation: 'MEMBER',
      },
    ],
  });
  const verdictOf = async (cqEnv: ReturnType<typeof env>, candidate = MEMBER_OBJECTS) => {
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv });
    return ((await op({ candidate, nowMs: NOW_MS })) as { value: { verdict: string } }).value
      .verdict;
  };

  test('reproduction: only CQ_MERGE_TRUSTED_BOTS set, a MEMBER objection still blocks the merge', async () => {
    expect(await verdictOf(env({ CQ_MERGE_TRUSTED_BOTS: 'good[bot]' }))).not.toBe('eligible');
  });

  test('each key set alone leaves the other two at their documented defaults', () => {
    const t = (v: Record<string, string>) => resolveClassifyTrust('t', undefined, env(v));
    expect(t({ CQ_MERGE_TRUSTED_BOTS: 'good[bot]' })).toEqual({
      trustedBots: ['good[bot]'],
      trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      acceptReviewStates: ['APPROVED'],
    });
    expect(t({ CQ_MERGE_TRUSTED_ASSOCIATIONS: 'owner' })).toEqual({
      trustedBots: [],
      trustedAssociations: ['OWNER'],
      acceptReviewStates: ['APPROVED'],
    });
    expect(t({ CQ_MERGE_ACCEPT_REVIEW_STATES: 'approved,commented' })).toEqual({
      trustedBots: [],
      trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      acceptReviewStates: ['APPROVED', 'COMMENTED'],
    });
  });

  test('a configured COMMENTED acceptance state is usable under the resolved policy, and never masks an objection', async () => {
    const cqEnv = env({ CQ_MERGE_ACCEPT_REVIEW_STATES: 'COMMENTED' });
    const commented = (state: 'COMMENTED' | 'CHANGES_REQUESTED', at: string) => ({
      id: `c-${state}-${at}`,
      authorLogin: 'maintainer',
      state,
      body: 'looked at it',
      submittedAt: at,
      authorAssociation: 'MEMBER' as const,
    });
    const ok = eligible(7, { reviews: [commented('COMMENTED', '2026-01-01T00:00:00.500Z')] });
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv });
    const r = (await op({ candidate: ok, nowMs: NOW_MS })) as {
      value: { verdict: string; reason: string };
    };
    expect(r.value.reason).not.toBe('no_acceptable_review');
    const blocked = eligible(8, {
      reviews: [
        commented('CHANGES_REQUESTED', '2026-01-01T00:00:00.400Z'),
        commented('COMMENTED', '2026-01-01T00:00:00.800Z'),
      ],
    });
    const b = (await op({ candidate: blocked, nowMs: NOW_MS })) as { value: { reason: string } };
    expect(b.value.reason).toBe('merge_objection_outstanding');
  });

  test('none set: nothing synthesised (built-in classifier behaviour unchanged); a restated documented default is accepted', () => {
    expect(resolveClassifyTrust('t', undefined, env())).toEqual({});
    expect(
      resolveClassifyTrust(
        't',
        { trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'] },
        env(),
      ),
    ).toEqual({});
    expect(() => resolveClassifyTrust('t', { trustedAssociations: ['OWNER'] }, env())).toThrow(
      /trust input/,
    );
  });

  test('runPrs: the env-synthesised trust merges into the caller classifyConfig; excluded reviewers cannot merge', async () => {
    const effects = new FakeMergeEffects();
    const cqEnv = env({
      CQ_MERGE_TRUSTED_BOTS: 'good[bot]',
      CQ_MERGE_TRUSTED_ASSOCIATIONS: 'MEMBER',
    });
    const excludedApproval = eligible(5, {
      reviews: [
        {
          id: 'x',
          authorLogin: 'excluded-member',
          state: 'APPROVED',
          body: 'approving the cache changes',
          submittedAt: '2026-01-01T00:00:00.500Z',
          authorAssociation: 'MEMBER',
        },
      ],
    });
    const op = makeRunMergePrsOp({ effects, cqEnv });
    // the in-process classifyConfig (a library field) carries excludedLogins + automationLogin
    const result = (await op({
      baseBranch: 'main',
      repoRoot: '.',
      prs: [excludedApproval],
      nowMs: NOW_MS,
      classifyConfig: {
        ...defaultClassifyPrConfig,
        excludedLogins: ['excluded-member'],
        automationLogin: 'cq-automation[bot]',
      },
    } as never)) as { value: { firstPass: { merged: unknown[] } } };
    expect(result.value.firstPass.merged).toEqual([]);
    expect(effects.calls.filter((c) => c.startsWith('merge'))).toEqual([]);
  });
});
