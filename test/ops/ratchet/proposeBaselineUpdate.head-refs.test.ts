// git-ref validation of headPrefix and base: the arg-error tables and
// the git check-ref-format-verified scoping (PR #110/#118 reviews and
// review-debt #87).
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedBaseline,
  TARGET,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('a custom headPrefix names the head branch', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: match.stringMatching(/^ratchet\/nightly-[0-9a-f]{12}$/) },
    });
  });

  test('headPrefix must form a valid git ref (arg-error table)', async () => {
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    for (const bad of [
      '',
      '/leading',
      'trailing/',
      'ratchet//propose',
      'ratchet/.hidden',
      'has..dots',
      'has space',
    ]) {
      await expect(propose(proposeInput({ headPrefix: bad }))).resolves.toEqual({
        status: 'failed',
        error: "ratchet: invalid input — 'headPrefix' would form an invalid git ref",
      });
    }
    // Non-strings keep the plain must-be-a-string wording.
    await expect(propose(proposeInput({ headPrefix: 7 as unknown as string }))).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'headPrefix' must be a string",
    });
    // Ref validation fires at the boundary: no effects call ever happened.
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a valid headPrefix with dots, dashes and slashes is accepted', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly.v1-beta',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: match.stringMatching(/^ratchet\/nightly\.v1-beta-[0-9a-f]{12}$/) },
    });
  });

  test('git-accurate scoping, VERIFIED against check-ref-format: whole-ref dots, per-component .lock (PR #110/#118 reviews)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    // Verified 2026-09-16 with `git check-ref-format --branch`: the
    // trailing-DOT rule binds the complete ref's END only ('release./main'
    // VALID, 'main.' invalid) — but *.lock binds EVERY component
    // ('ratchet.lock/nightly' INVALID per git's own docs). A prefix ending
    // '.lock' or '.' composes with the digest into a legal head.
    for (const headPrefix of ['release.lock', 'main.']) {
      const result = await createProposeBaselineUpdate(effects)(
        proposeInput({ headPrefix, improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      );
      expect(result.status, headPrefix).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.head, headPrefix).toMatch(
          new RegExp(`^${headPrefix.replace(/[.]/g, '\\.')}-[0-9a-f]{12}$`),
        );
      }
    }
    const midDot = await createProposeBaselineUpdate(effects)(
      proposeInput({
        base: 'release./main',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(midDot.status).toBe('ok');
    // A .lock COMPONENT anywhere is invalid — prefix or base.
    for (const bad of ['ratchet.lock/nightly', 'a/b.lock/c']) {
      const asPrefix = await createProposeBaselineUpdate(effects)(
        proposeInput({
          headPrefix: bad,
          improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
        }),
      );
      expect(asPrefix.status, bad).toBe('failed');
      const asBase = await createProposeBaselineUpdate(effects)(
        proposeInput({ base: bad, improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      );
      expect(asBase.status, bad).toBe('failed');
    }
  });

  test('an UNDERSCORE-bearing headPrefix is accepted (review-debt #87: git allows _ in ref segments)', async () => {
    // The old character class excluded '_' — stricter than git. A prefix
    // like 'ratchet/nightly_lock' is a perfectly legal branch name.
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly_lock',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: match.stringMatching(/^ratchet\/nightly_lock-[0-9a-f]{12}$/) },
    });
  });

  test('base gets the same git-ref discipline (arg-error table)', async () => {
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    for (const bad of [
      '',
      '/lead',
      'trail/',
      'dou//ble',
      'do..ts',
      'seg/.hidden',
      '.dot',
      'has space',
      // PR #110 review: the trailing-dot and *.lock restrictions bind the
      // END of the COMPLETE ref (git's own scoping) — 'main.' and
      // 'release.lock' reject as bases; a MID-ref '.lock' component
      // ('ratchet.lock/nightly') is legal and moved to the positive rows.
      'main.',
      'release.lock',
    ]) {
      await expect(propose(proposeInput({ base: bad }))).resolves.toEqual({
        status: 'failed',
        error: "ratchet: invalid input — 'base' would form an invalid git ref",
      });
    }
    // Ref validation fires at the boundary: no effects call ever happened.
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a hostile base never reaches the PR body: refused at the boundary; a clean base renders in the target line', async () => {
    // A base carrying markdown-breaking characters fails ref validation —
    // it can never render into the body at all (the mdSafe render of base
    // is defense-in-depth behind that refusal).
    const hostile = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(hostile)(proposeInput({ base: 'ma`in\nbranch' })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'base' would form an invalid git ref",
    });
    expect(hostile.upsertCalls()).toBe(0);
    // A clean base renders in the body's target line and rides the upsert.
    await seedBaseline(TARGET, METRIC, 10);
    const clean = makeFakeEffects();
    await createProposeBaselineUpdate(clean)(
      proposeInput({
        base: 'release/main',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    const pr = clean.prs.values().next().value;
    expect(pr?.body).toContain('Target branch: `release/main`.');
    expect(pr?.base).toBe('release/main');
  });
});
