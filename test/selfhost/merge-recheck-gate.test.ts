import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  gateMergeEffects,
  recheckBeforeMerge,
} from '../../src/selfhost/merge-recheck.js';
import type { RecheckResult } from '../../src/selfhost/merge-recheck.js';
import {
  BASE_NAME,
  LATER,
  OWNER,
  PREFIX,
  REPO,
  SETTLE_MS,
  SHA_A,
  SHA_B,
  gated,
  innerEffects,
  makeForge,
  okRes,
  prSpec,
  readAndMerge,
  recheckDeps,
  review,
  seedObservation,
  unprocessable,
} from './merge-recheck.helpers.js';
import type { PrSpec } from './merge-recheck.helpers.js';

describe('recheckBeforeMerge + gateMergeEffects', () => {
  test('refusals: head moved, unpinned, closed, draft, truncated reviews', async () => {
    const cases: Array<[Partial<PrSpec>, string | undefined, RegExp]> = [
      [{ head: SHA_A }, SHA_B, /^head moved/],
      [{}, undefined, /^unpinned head/],
      [{}, 'deadbeef', /^unpinned head/],
      [{ state: 'CLOSED' }, SHA_B, /not open/],
      [{ isDraft: true }, SHA_B, /draft/],
      [{ reviewsHasNext: true }, SHA_B, /truncated/],
      [{ base: 'zz' }, SHA_B, /base oid unavailable/],
    ];
    for (const [over, head, pattern] of cases) {
      const forge = makeForge({ 7: prSpec({ reviews: [review()], ...over }) });
      const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, head, BASE_NAME);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toMatch(pattern);
    }
  });

  test('state-branch write CAS failure → refuse; nothing merges', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.hook = (args) =>
      args.includes('PATCH') ? unprocessable('Update is not a fast forward') : undefined;
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.stderr).toMatch(/settle state not durable/);
    expect(mergeCalls).toEqual([]);
  });

  test('state-branch read failure (non-404) → refuse', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    forge.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^settle state not durable: gh exit 1/) as unknown,
    });
  });

  test('gh throw → refuse, never throws', async () => {
    const throwing: GhFn = () => Promise.reject(new Error('spawn gh ENOENT\nstack…'));
    const result = await recheckBeforeMerge(
      {
        gh: throwing,
        owner: OWNER,
        repo: REPO,
        nowMs: () => LATER,
        settleMs: SETTLE_MS,
        policy: CONSERVATIVE_TRUST_POLICY,
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(result).toEqual({ ok: false, reason: 'recheck fetch failed: spawn gh ENOENT' });
    const badClock = await recheckBeforeMerge(
      {
        ...recheckDeps(makeForge({ 7: prSpec({ reviews: [review()] }) }), LATER),
        nowMs: () => Number.NaN,
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(badClock.ok).toBe(false);
  });

  test('base pin: no successful readBaseRef → base unverified; a failed read forgets the pin; the pin is single-use', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const inner = innerEffects(forge);
    let readAnswer: { ok: boolean; baseRefName?: string } = { ok: true, baseRefName: BASE_NAME };
    const effects = gateMergeEffects(
      { ...inner.effects, readBaseRef: () => Promise.resolve(readAnswer) },
      (pr, head, base) => recheckBeforeMerge(recheckDeps(forge, LATER), pr, head, base),
    );
    const opts = { method: 'merge' as const, matchHeadCommit: SHA_B };
    // No read at all.
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/refused pr 7: base unverified/);
    // A successful read, then a failed one: the older pin is forgotten.
    await effects.readBaseRef(7);
    readAnswer = { ok: false };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    // An ok read with an empty name pins nothing.
    readAnswer = { ok: true, baseRefName: '' };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    expect(inner.mergeCalls).toEqual([]);
    // A good read pins exactly one merge call.
    readAnswer = { ok: true, baseRefName: BASE_NAME };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).code).toBe(0);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    expect(inner.mergeCalls).toHaveLength(1);
  });

  test('base pin: the recheck receives the base readBaseRef saw, per PR', async () => {
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const seen: Array<[number, string | undefined]> = [];
    const effects = gateMergeEffects(
      {
        ...inner.effects,
        readBaseRef: (pr) => Promise.resolve({ ok: true, baseRefName: `base-${String(pr)}` }),
      },
      (pr, _head, base) => {
        seen.push([pr, base]);
        return Promise.resolve({ ok: false, reason: 'stub' });
      },
    );
    await effects.readBaseRef(1);
    await effects.readBaseRef(2);
    await effects.mergePr(2, { method: 'merge', matchHeadCommit: SHA_B });
    await effects.mergePr(1, { method: 'merge', matchHeadCommit: SHA_B });
    expect(seen).toEqual([
      [2, 'base-2'],
      [1, 'base-1'],
    ]);
  });

  test('a live base that differs from the pinned base → base changed; nothing merges', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()], baseName: 'release' }) });
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.stderr).toMatch(
      /refused pr 7: base changed: readBaseRef pinned merge-queue but the forge now reports release/,
    );
    expect(mergeCalls).toEqual([]);
  });

  test('a live base of the protected branch is refused outright, even when pinned', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()], baseName: 'main' }) });
    await seedObservation(forge, [7]);
    const result = await recheckBeforeMerge(
      { ...recheckDeps(forge, LATER), protectedBranch: 'main' },
      7,
      SHA_B,
      'main',
    );
    expect(result).toEqual({
      ok: false,
      reason: 'base is the protected branch main: never merged into',
    });
    // Without a protected branch configured the same pin would pass the base gate.
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, 'main')).ok).toBe(true);
  });

  test('open bot threads do not block accepted heads', async () => {
    const forge = makeForge({
      7: prSpec({
        reviews: [review()],
        threads: [{ isResolved: false, root: 'coderabbitai[bot]' }],
      }),
    });
    await seedObservation(forge, [7]);
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).ok).toBe(
      true,
    );
  });

  test('discarded ledger records surface on a refusal reason and on an ok result', async () => {
    // Refusal: a foreign ledger is discarded wholesale → single observation.
    const foreign = makeForge({ 7: prSpec({ reviews: [review()] }) });
    foreign.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? okRes({ object: { sha: 'e'.repeat(40) } })
        : (args[1] ?? '').includes('contents/')
          ? okRes({ encoding: 'base64', content: Buffer.from('{"version":9}').toString('base64') })
          : undefined;
    expect(await recheckBeforeMerge(recheckDeps(foreign, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason:
        'settle: single_observation (state discarded: 1 record(s); first: settle state version 9 is not 1)',
    });

    // Ok: a settled ledger that also carries one malformed record.
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const tip = forge.refs.get('refs/heads/cq-state') ?? '';
    const res = await forge.gh(['api', `${PREFIX}contents/.cq/settle-state.json?ref=${tip}`]);
    const file = JSON.parse(res.stdout) as { content: string };
    const ledger = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as {
      prs: Record<string, unknown>;
    };
    ledger.prs['x'] = {};
    const tampered = Buffer.from(JSON.stringify(ledger)).toString('base64');
    forge.hook = (args) =>
      (args[1] ?? '').includes('contents/')
        ? okRes({ encoding: 'base64', content: tampered })
        : undefined;
    const ok = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(ok).toMatchObject({ ok: true, discarded: ['pr key "x" is not a decimal PR number'] });
  });

  test('refusal stderr does not match /base branch was modified/i', async () => {
    const recheck = (): Promise<RecheckResult> =>
      Promise.resolve({ ok: false, reason: 'forge said: Base branch was modified' });
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const result = await gateMergeEffects(inner.effects, recheck).mergePr(9, { method: 'merge' });
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toMatch(/^cq merge-time recheck refused pr 9: /);
    expect(result.stderr).not.toMatch(/base branch was modified/i);
    expect(inner.mergeCalls).toEqual([]);
  });

  test('every non-merge member delegates to the inner effects', async () => {
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const effects = gateMergeEffects(inner.effects, () => Promise.reject(new Error('never')));
    expect(await effects.validateRef('x')).toEqual({ ok: true, sha: SHA_B });
    expect(await effects.readBaseRef(1)).toEqual({ ok: true, baseRefName: BASE_NAME });
    expect(await effects.worktreePrepare(3, 'r')).toEqual({ path: '/tmp/pr-3' });
    expect((await effects.fetchRef('r')).code).toBe(0);
    expect((await effects.retargetBase(1, 'main')).code).toBe(0);
    expect((await effects.pushRef('a:b', '/p')).code).toBe(0);
    await expect(effects.worktreeRemove('/p')).resolves.toBeUndefined();
  });
});
