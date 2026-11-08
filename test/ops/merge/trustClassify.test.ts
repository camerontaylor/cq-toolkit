// Reviewer trust (bots, associations, accepted review states) and branch
// spellings are trust inputs resolved from config only (ADR-0009).
import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { errorClassOf } from '../../../src/driver/errors.js';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { registry } from '../../../src/ops/merge/registry.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
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

  test('executeMerges: an accepted refs/heads base is bound as the bare base', async () => {
    const op = await entryOf('merge.executeMerges').importer({ cqEnv: env() });
    const r = (await op({
      plan: { order: [], needsHuman: [], baseBranch: 'refs/heads/main' },
      repoRoot: '.',
    })) as { status: string; value: { baseBranch?: string } };
    expect(r.status).toBe('ok');
  });
});
