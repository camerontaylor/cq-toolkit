import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Idempotency (header pins 2 and 2b): the 12-hex head digest over the
// sorted pairs, re-run updates of the same open PR, duplicate
// (target, metric) last-wins collapse, and the upsert result's
// authoritative PR identity.
import { createHash } from 'node:crypto';
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import type { BaselinePrEffects } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedBaseline,
  TARGET,
} from './proposeBaselineUpdate.helpers.js';
import type { FakePr } from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('re-running the SAME improvements updates the SAME open PR — still exactly one, no second create', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    const input = proposeInput({
      improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
    });
    const first = await propose(input);
    expect(first).toMatchObject({ status: 'ok', value: { proposal: 'created', prNumber: 1 } });
    const second = await propose(input);
    expect(second).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'updated',
        prNumber: 1,
        prUrl: 'https://github.com/acme/repo/pull/1',
      },
    });
    expect(effects.prs.size).toBe(1);
    expect(effects.findCalls()).toBe(2);
    expect(effects.upsertCalls()).toBe(2); // one create, one in-place update
  });

  test('duplicate (target, metric): a later looser reading SUPERSEDES the earlier tightening — metric dropped', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    // The newest evidence is the truth: the looser LAST reading drops the
    // metric from the proposal entirely — never kept at the older tightened
    // value 7 — and the superseded tightening leaves no record either.
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: TARGET, metric: METRIC, value: 12 },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: match.stringMatching(/10 → 12 is not a tightening/),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('duplicate (target, metric): a later tightening after a looser entry still proposes', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 12 },
            { target: TARGET, metric: METRIC, value: 7 },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 7 }], skipped: [] },
    });
    expect(effects.prs.size).toBe(1);
  });

  test('duplicate (target, metric): the LAST tightened value wins (v3, not v2)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 },
          { target: TARGET, metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 5 }] },
    });
    const pr = effects.prs.values().next().value;
    expect(pr?.files[0]?.content).toContain('"value": 5');
  });

  test('the UPSERT result carries the authoritative PR identity (a found PR can close between find and upsert)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async closeOpenPrByHead() {},
      async findOpenPrByHead() {
        // Stale view: PR 7 was open at find time…
        return { number: 7, url: 'https://github.com/acme/repo/pull/7' };
      },
      async commitAndUpsertPr(input) {
        // …but it was closed/merged before the upsert, so the impl created
        // PR 9 — ITS number/url is the truth the outcome must report.
        const pr: FakePr = {
          number: 9,
          url: 'https://github.com/acme/repo/pull/9',
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          commitMessage: input.commitMessage,
          files: input.files,
        };
        return { created: true, number: pr.number, url: pr.url };
      },
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        // review-debt #87 item 1: the VERDICT follows the upsert's
        // authoritative created flag — the found PR closed between find and
        // upsert, so the impl's fresh creation is BOTH the identity AND the
        // verdict truth (the old code said 'updated' from the stale find).
        proposal: 'created',
        prNumber: 9,
        prUrl: 'https://github.com/acme/repo/pull/9',
      },
    });
  });

  test('an upsert result lacking an identity falls back to the found PR', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async closeOpenPrByHead() {},
      async findOpenPrByHead() {
        return { number: 7, url: 'https://github.com/acme/repo/pull/7' };
      },
      async commitAndUpsertPr() {
        // A loosely typed impl that reports no number/url at all.
        return { created: false } as { created: boolean; number: number; url: string };
      },
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'updated',
        prNumber: 7,
        prUrl: 'https://github.com/acme/repo/pull/7',
      },
    });
  });

  test('the head is deterministic: same set in any order ⇒ same head; different set ⇒ different head', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    await seedBaseline('bundle-size', 'kb-total', 512);
    const effectsA = makeFakeEffects();
    const effectsB = makeFakeEffects();
    const [runA, runB] = await Promise.all([
      createProposeBaselineUpdate(effectsA)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: 'bundle-size', metric: 'kb-total', value: 480 },
          ],
        }),
      ),
      createProposeBaselineUpdate(effectsB)(
        proposeInput({
          improvements: [
            { target: 'bundle-size', metric: 'kb-total', value: 480 },
            { target: TARGET, metric: METRIC, value: 7 },
          ],
        }),
      ),
    ]);
    // The exact convention, pinned: first 12 hex (48 bits — format.ts's
    // baseline-path digest width) of sha256 over the canonical JSON of the
    // SORTED [target, metric] pairs of the applied set.
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify([
          ['bundle-size', 'kb-total'],
          [TARGET, METRIC],
        ]),
        'utf8',
      )
      .digest('hex')
      .slice(0, 12);
    const headA = runA.status === 'ok' && runA.value.head;
    const headB = runB.status === 'ok' && runB.value.head;
    expect(headA).toBe(`ratchet/propose-${expectedHash}`);
    expect(headB).toBe(headA);
    // A different applied set necessarily lands on a different head.
    const effectsC = makeFakeEffects();
    const runC = await createProposeBaselineUpdate(effectsC)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    const headC = runC.status === 'ok' && runC.value.head;
    expect(headC).not.toBe(headA);
  });
});

test('a later non-tightening reading withdraws only the exact proposal head', async () => {
  await seedBaseline(TARGET, METRIC, 10);
  const effects = makeFakeEffects();
  const op = createProposeBaselineUpdate(effects);
  const first = await op(
    proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 8 }] }),
  );
  expect(first.status).toBe('ok');
  if (first.status !== 'ok' || first.value.head === null) return;
  const existing = effects.prs.get(first.value.head);
  if (existing === undefined) throw new Error('proposal missing');
  effects.prs.set('unrelated-head', { ...existing, head: 'unrelated-head' });
  const rerun = await op(
    proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 11 }] }),
  );
  expect(rerun.status).toBe('ok');
  expect(effects.prs.has(first.value.head)).toBe(false);
  expect(effects.prs.has('unrelated-head')).toBe(true);
});

test('withdrawal failure is contained as indeterminate', async () => {
  await seedBaseline(TARGET, METRIC, 10);
  const effects = makeFakeEffects();
  effects.closeOpenPrByHead = async () => {
    throw new Error('close failed');
  };
  const result = await createProposeBaselineUpdate(effects)(
    proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 11 }] }),
  );
  expect(result.status).toBe('indeterminate');
});

test('mixed metric batches update and withdraw the same proposal as the tightening subset changes', async () => {
  await seedBaseline('coverage', 'coverage', 90, 'higher-is-better');
  await seedBaseline(TARGET, METRIC, 10);
  const effects = makeFakeEffects();
  const op = createProposeBaselineUpdate(effects);
  const readings = (coverage: number, typecheck: number) =>
    proposeInput({
      improvements: [
        { target: 'coverage', metric: 'coverage', value: coverage },
        { target: TARGET, metric: METRIC, value: typecheck },
      ],
    });
  const coveragePath = baselineRelPath('coverage', 'coverage');
  const coverageBase = await readFile(join(ws, coveragePath), 'utf8');
  const first = await op(readings(91, 10));
  expect(first.status).toBe('ok');
  if (first.status !== 'ok' || first.value.head === null) throw new Error('proposal missing');
  expect(first.value.applied.map((entry) => entry.metric)).toEqual(['coverage']);
  expect(
    parseBaseline(
      effects.prs.get(first.value.head)!.files.find((file) => file.path === coveragePath)!.content,
    ).value,
  ).toBe(91);
  const second = await op(readings(90, 9));
  expect(second).toMatchObject({
    status: 'ok',
    value: { proposal: 'updated', head: first.value.head },
  });
  expect(effects.prs.size).toBe(1);
  const updated = effects.prs.get(first.value.head)!;
  expect(updated.files.find((file) => file.path === coveragePath)?.content).toBe(coverageBase);
  expect(parseBaseline(updated.files.find((file) => file.path === REL)!.content).value).toBe(9);
  const last = await op(readings(90, 10));
  expect(last).toMatchObject({ status: 'ok', value: { proposal: 'none' } });
  expect(effects.prs.has(first.value.head)).toBe(false);
});
