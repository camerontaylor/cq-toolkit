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
  CLASSIFY_RULE_FIELDS,
  mergeClassifyConfig,
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

  test('a comma-only trust list activates the conservative defaults, the way the acceptance flow reads it', () => {
    const t = (v: Record<string, string>) => resolveClassifyTrust('t', undefined, env(v));
    // The key IS present, so policy mode is on and every field takes its
    // conservative default. Returning {} would drop the classifier into its
    // permissive legacy mode, which trusts reviewers the acceptance flow
    // would reject.
    expect(t({ CQ_MERGE_ACCEPT_REVIEW_STATES: ',' })).toEqual({
      trustedBots: [],
      trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      acceptReviewStates: ['APPROVED'],
    });
    const commaOnly = {
      CQ_MERGE_ACCEPT_REVIEW_STATES: ' , ',
      CQ_MERGE_TRUSTED_BOTS: 'good[bot]',
    };
    expect(t(commaOnly)).toEqual({
      trustedBots: ['good[bot]'],
      trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      acceptReviewStates: ['APPROVED'],
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

  test('a bot skip/failure notice is never acceptance, with or without automationLogin', async () => {
    const skip = (state: 'COMMENTED' | 'APPROVED') => ({
      id: `s-${state}`,
      authorLogin: 'coderabbitai[bot]',
      state,
      body: 'CodeRabbit skipped this run because the PR is too large',
      submittedAt: '2026-01-01T00:00:00.500Z',
    });
    const cqEnv = env({
      CQ_MERGE_TRUSTED_BOTS: 'coderabbitai[bot]',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'COMMENTED,APPROVED',
    });
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv });
    for (const state of ['COMMENTED', 'APPROVED'] as const) {
      for (const config of [undefined, { automationLogin: 'x' }]) {
        const r = (await op({
          candidate: eligible(9, { reviews: [skip(state)] }),
          nowMs: NOW_MS,
          ...(config ? { config } : {}),
        })) as { value: { reason: string } };
        expect(r.value.reason).toBe('no_acceptable_review');
      }
    }
    // the reproduction through runPrs: plan automationLogin must not make the notice merge
    const effects = new FakeMergeEffects();
    const run = makeRunMergePrsOp({ effects, cqEnv });
    const out = (await run({
      baseBranch: 'main',
      repoRoot: '.',
      nowMs: NOW_MS,
      prs: [eligible(9, { reviews: [skip('COMMENTED')] })],
      config: { automationLogin: 'x' },
    })) as { value: { firstPass: { merged: unknown[] } } };
    expect(out.value.firstPass.merged).toEqual([]);
    expect(effects.calls.filter((c) => c.startsWith('merge'))).toEqual([]);
  });

  test('plan config can only narrow: excludedLogins union, settle never shortened, conflicting automationLogin fails config', async () => {
    const cqEnv = env({
      CQ_MERGE_TRUSTED_ASSOCIATIONS: 'MEMBER',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'COMMENTED',
    });
    const member = eligible(11, {
      reviews: [
        {
          id: 'x',
          authorLogin: 'excluded-member',
          state: 'COMMENTED',
          body: 'looked at it',
          submittedAt: '2026-01-01T00:00:00.500Z',
          authorAssociation: 'MEMBER',
        },
      ],
    });
    const effects = new FakeMergeEffects();
    const op = makeRunMergePrsOp({ effects, cqEnv });
    const hostCfg = {
      ...defaultClassifyPrConfig,
      excludedLogins: ['excluded-member'],
      automationLogin: 'cq-automation[bot]',
    };
    const base = {
      baseBranch: 'main',
      repoRoot: '.',
      nowMs: NOW_MS,
      prs: [member],
      classifyConfig: hostCfg,
    };
    const dropped = (await op({ ...base, config: { excludedLogins: [] } } as never)) as {
      value: { firstPass: { merged: unknown[] } };
    };
    expect(dropped.value.firstPass.merged).toEqual([]);
    const shortened = mergeClassifyConfig('t', hostCfg, { settleWindowMs: 0 });
    expect(shortened.settleWindowMs).toBe(defaultClassifyPrConfig.settleWindowMs);
    effects.calls.length = 0;
    const err = await op({ ...base, config: { automationLogin: 'other' } } as never).catch(
      (e: unknown) => e,
    );
    expect(errorClassOf(err)).toBe('config');
    expect(effects.calls).toEqual([]);
  });

  test('automationLogin:null from the plan cannot make a skip notice acceptance; a normal trusted COMMENTED review still is', async () => {
    const cqEnv = env({
      CQ_MERGE_TRUSTED_BOTS: 'coderabbitai[bot]',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'COMMENTED',
    });
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv });
    const review = (body: string) => ({
      id: 'r',
      authorLogin: 'coderabbitai[bot]',
      state: 'COMMENTED' as const,
      body,
      submittedAt: '2026-01-01T00:00:00.500Z',
    });
    const reason = async (body: string, config?: object) =>
      (
        (await op({
          candidate: eligible(12, { reviews: [review(body)] }),
          nowMs: NOW_MS,
          ...(config ? { config } : {}),
        })) as { value: { reason: string } }
      ).value.reason;
    expect(
      await reason('CodeRabbit skipped this run because the PR is too large', {
        automationLogin: null,
      }),
    ).toBe('no_acceptable_review');
    expect(await reason('walked through the change, looks plausible')).not.toBe(
      'no_acceptable_review',
    );
  });

  test('the classify merge is deny-by-default: every ClassifyPrConfig field has a rule, unknown or pattern fields fail config', () => {
    expect([...CLASSIFY_RULE_FIELDS].sort()).toEqual(
      [
        'acceptReviewStates',
        'allClearPattern',
        'automationLogin',
        'excludedLogins',
        'settleWindowMs',
        'skipPatterns',
        'trustedAssociations',
        'trustedBots',
      ].sort(),
    );
    for (const field of ['skipPatterns', 'allClearPattern', 'brandNewField']) {
      let err: unknown;
      try {
        mergeClassifyConfig('t', defaultClassifyPrConfig, { [field]: 'x' });
      } catch (e) {
        err = e;
      }
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).toContain(field);
      expect(String(err)).not.toContain('"x"');
    }
    // a lowercase restated list is normalised, not applied verbatim
    expect(
      mergeClassifyConfig('t', defaultClassifyPrConfig, {
        trustedAssociations: ['member'],
        acceptReviewStates: ['approved'],
      }),
    ).toMatchObject({ trustedAssociations: ['MEMBER'], acceptReviewStates: ['APPROVED'] });
  });

  test('a plan-supplied nowMs later than the real clock, or invalid, is a config error (no clamp)', async () => {
    const op = await entryOf('merge.classifyPrs').importer({ cqEnv: env() });
    const now = Date.now();
    // a review AFTER lastCommitAt, no all-clear body: only the clock decides the verdict
    const fresh = eligible(13, {
      lastCommitAt: new Date(now - 5000).toISOString(),
      reviews: [
        {
          id: 'r13',
          authorLogin: 'alice',
          state: 'APPROVED',
          body: 'approving the cache changes',
          submittedAt: new Date(now - 4000).toISOString(),
        },
      ],
    });
    const verdict = async (nowMs: unknown) =>
      (await op({ candidate: fresh, nowMs } as never).catch((e: unknown) => e)) as {
        value?: { reason: string };
      };
    // the real clock: the window has not elapsed
    expect((await verdict(now)).value?.reason).toBe('settle_window_pending');
    // a later clock would skip the wait; it is rejected, never accepted or clamped
    // 4102444800123 is a distinctive far-future reading: it must never appear in the message
    for (const bad of [4102444800123, now + 30 * 24 * 3600 * 1000, Number.NaN, -1, Infinity, 'x']) {
      const err = await verdict(bad);
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).toContain('input.nowMs');
      expect(String(err)).not.toContain('4102444800123');
      expect(String(err)).not.toContain(String(bad));
    }
    // runPrs rejects the same before any effect
    const effects = new FakeMergeEffects();
    const run = makeRunMergePrsOp({ effects, cqEnv: env() });
    const err = await run({
      baseBranch: 'main',
      repoRoot: '.',
      prs: [fresh],
      nowMs: now + 30 * 24 * 3600 * 1000,
    }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(effects.calls).toEqual([]);
  });

  test('prototype-named plan keys are refused as unknown fields, not ignored', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const plan = JSON.parse(`{"${key}": {"x": 1}}`) as Record<string, unknown>;
      let err: unknown;
      try {
        mergeClassifyConfig('t', defaultClassifyPrConfig, plan);
      } catch (e) {
        err = e;
      }
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).toContain(key);
    }
  });

  test('a wrong-shape known field is a config error, never a TypeError', () => {
    const shapes: Array<[string, unknown]> = [
      ['excludedLogins', 'a-string'],
      ['excludedLogins', { a: 1 }],
      ['excludedLogins', [1]],
      ['settleWindowMs', '5'],
      ['settleWindowMs', Number.NaN],
      ['settleWindowMs', -1],
      ['automationLogin', 7],
      ['trustedBots', 'x'],
      ['trustedBots', [1]],
      ['trustedAssociations', { 0: 'MEMBER' }],
      ['trustedAssociations', 'MEMBER'],
      ['acceptReviewStates', [null]],
      ['acceptReviewStates', 'APPROVED'],
    ];
    for (const [field, value] of shapes) {
      let err: unknown;
      try {
        mergeClassifyConfig('t', defaultClassifyPrConfig, { [field]: value });
      } catch (e) {
        err = e;
      }
      expect(err, `${field}=${JSON.stringify(value)}`).toBeInstanceOf(Error);
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).toContain(field);
    }
  });

  test('wrong-shape trustedAssociations/acceptReviewStates fail config (not TypeError) through BOTH ops', async () => {
    const shapes: unknown[] = ['MEMBER', [1], [null], { 0: 'MEMBER' }, 7, true, [['MEMBER']]];
    const classify = await entryOf('merge.classifyPrs').importer({ cqEnv: env() });
    const effects = new FakeMergeEffects();
    const run = makeRunMergePrsOp({ effects, cqEnv: env() });
    for (const field of ['trustedAssociations', 'acceptReviewStates', 'trustedBots']) {
      for (const shape of shapes) {
        const config = { [field]: shape };
        const e1 = await classify({ candidate, nowMs: NOW_MS, config } as never).catch(
          (e: unknown) => e,
        );
        expect(e1, `classify ${field}`).toBeInstanceOf(Error);
        expect(errorClassOf(e1), `classify ${field}=${JSON.stringify(shape)}`).toBe('config');
        const e2 = await run({
          baseBranch: 'main',
          repoRoot: '.',
          prs: [],
          nowMs: NOW_MS,
          config,
        } as never).catch((e: unknown) => e);
        expect(errorClassOf(e2), `runPrs ${field}=${JSON.stringify(shape)}`).toBe('config');
        expect(String(e2)).toContain(field);
      }
    }
    expect(effects.calls).toEqual([]);
  });

  test('a conflicting automationLogin message never echoes either value', () => {
    let err: unknown;
    try {
      mergeClassifyConfig(
        't',
        { ...defaultClassifyPrConfig, automationLogin: 'host-secret-login' },
        { automationLogin: 'plan-attacker-login' },
      );
    } catch (e) {
      err = e;
    }
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).not.toContain('host-secret-login');
    expect(String(err)).not.toContain('plan-attacker-login');
  });

  test('schema level: a negative, NaN or Infinity settleWindowMs is rejected at dispatch', () => {
    // schema-valid candidates (the twin is strict: no headRefName/baseRefName/state on the classify twin)
    const { headRefName: _h, baseRefName: _b, state: _s, ...plain } = candidate;
    const runCandidate = { ...candidate };
    for (const entryName of ['merge.classifyPrs', 'merge.runPrs']) {
      const schema = entryOf(entryName).inputSchema;
      for (const bad of [-1, Number.NaN, Infinity]) {
        const input =
          entryName === 'merge.classifyPrs'
            ? { candidate: plain, nowMs: NOW_MS, config: { settleWindowMs: bad } }
            : {
                baseBranch: 'main',
                repoRoot: '.',
                prs: [runCandidate],
                config: { settleWindowMs: bad },
              };
        expect(schema.safeParse(input).success, `${entryName} ${String(bad)}`).toBe(false);
      }
      const ok =
        entryName === 'merge.classifyPrs'
          ? { candidate: plain, nowMs: NOW_MS, config: { settleWindowMs: 1 } }
          : {
              baseBranch: 'main',
              repoRoot: '.',
              prs: [runCandidate],
              config: { settleWindowMs: 1 },
            };
      expect(schema.safeParse(ok).success).toBe(true);
    }
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
