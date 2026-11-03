// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.admission.test.ts,
// addressManyPlan.admissionStop.test.ts, addressManyPlan.coverage.test.ts,
// addressManyPlan.attribution.test.ts and addressManyPlan.outcomes.test.ts.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ADDRESS_MANY_CONCURRENCY,
  resolveAddressManyConcurrency,
  selectAddressMany,
} from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  facts,
  hostile,
  listing,
  policy,
  selected,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe('selectAddressMany', () => {
  test('admits owner, viewer and an explicitly allowlisted bot, preserving spelling', () => {
    const candidates = selected(
      [
        facts({ number: 1, author: { login: 'Owner', type: 'User' }, headOid: HEAD_A }),
        facts({ number: 2, author: { login: 'VIEWER', type: 'User' }, headOid: HEAD_B }),
        facts({ number: 3, author: { login: 'Dependabot[bot]', type: 'Bot' }, headOid: HEAD_C }),
      ],
      { owner: 'owner', viewer: 'viewer', botLogins: ['dependabot[bot]'] },
    );
    expect(
      candidates.map((candidate) => [candidate.number, candidate.authorLogin, candidate.matchedBy]),
    ).toEqual([
      [1, 'Owner', 'owner'],
      [2, 'VIEWER', 'viewer'],
      [3, 'Dependabot[bot]', 'bot-allowlist'],
    ]);
  });

  test('treats an empty bot allowlist as authorizing no bot, and Bot type as no authority', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, author: { login: 'renovate[bot]', type: 'Bot' } }),
        facts({ number: 2, author: { login: 'stranger', type: 'User' } }),
      ]),
      policy({ botLogins: [] }),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.candidates).toEqual([]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [1, { reason: 'unauthorized-author', authorType: 'Bot' }],
      [2, { reason: 'unauthorized-author', authorType: 'User' }],
    ]);
  });

  test('requires a server-typed Bot for an allowlisted login and keeps owner authority independent', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, author: { login: 'Dependabot[BOT]', type: 'Bot' }, headOid: HEAD_A }),
        facts({ number: 2, author: { login: 'renovate[bot]', type: 'User' }, headOid: HEAD_B }),
        facts({
          number: 3,
          author: { login: 'Renovate[bot]', type: 'Organization' },
          headOid: HEAD_C,
        }),
        facts({ number: 4, author: { login: 'stranger[bot]', type: 'Bot' } }),
        facts({ number: 5, author: { login: 'OWNER', type: 'User' } }),
      ]),
      policy({ botLogins: ['dependabot[bot]', 'renovate[bot]'] }),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    // A listed login is Bot authority only for a server-typed Bot: the same
    // login carried by a User or Organization is an unauthorized author, and a
    // Bot with no allowlist entry stays excluded. Owner authority is
    // independent of the author type and of the allowlist.
    expect(
      selection.candidates.map((candidate) => [
        candidate.number,
        candidate.authorLogin,
        candidate.matchedBy,
      ]),
    ).toEqual([
      [1, 'Dependabot[BOT]', 'bot-allowlist'],
      [5, 'OWNER', 'owner'],
    ]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [2, { reason: 'unauthorized-author', authorType: 'User' }],
      [3, { reason: 'unauthorized-author', authorType: 'Organization' }],
      [4, { reason: 'unauthorized-author', authorType: 'Bot' }],
    ]);
  });

  test('excludes closed, merged, draft and deleted-head PRs with their own reasons', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, state: 'CLOSED' }),
        facts({ number: 2, state: 'MERGED' }),
        facts({ number: 3, isDraft: true }),
        facts({ number: 4, headRepository: '' }),
        facts({ number: 5 }),
      ]),
      policy(),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.candidates.map((candidate) => candidate.number)).toEqual([5]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [1, { reason: 'not-open', state: 'CLOSED' }],
      [2, { reason: 'not-open', state: 'MERGED' }],
      [3, { reason: 'draft' }],
      [4, { reason: 'head-repository-deleted' }],
    ]);
  });

  test('refuses an incomplete listing instead of returning an empty success', () => {
    expect(selectAddressMany(listing([]), policy())).toMatchObject({
      ok: true,
      candidates: [],
    });
    for (const pulls of [[], [facts()]] as const) {
      const refused = selectAddressMany(listing(pulls, { complete: false }), policy());
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.kind).toBe('incomplete-listing');
      if (refused.refusal.kind !== 'incomplete-listing') continue;
      expect(refused.refusal.detail.length).toBeGreaterThan(0);
    }
  });

  test('refuses a listing for another repo, or an entry from another repo', () => {
    expect(selectAddressMany(listing([facts()], { repo: 'other/repo' }), policy())).toMatchObject({
      ok: false,
      refusal: { kind: 'repo-mismatch' },
    });
    expect(selectAddressMany(listing([facts({ repo: 'other/repo' })]), policy())).toMatchObject({
      ok: false,
      refusal: { kind: 'invalid-facts' },
    });
  });

  test('refuses structurally invalid facts with per-entry violations', () => {
    const selection = selectAddressMany(
      listing([
        hostile({ ...facts({ number: 1 }), isDraft: undefined }),
        hostile({ ...facts({ number: 2 }), headOid: 'not-an-oid' }),
        hostile({ ...facts({ number: 3 }), headRefName: '   ' }),
        hostile({ ...facts({ number: 4 }), number: 1.5 }),
        hostile({ ...facts({ number: 5 }), author: { login: '', type: 'User' } }),
      ]),
      policy(),
    );
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.refusal.kind).toBe('invalid-facts');
    if (selection.refusal.kind !== 'invalid-facts') return;
    expect(selection.refusal.violations.map((violation) => violation.field)).toEqual([
      'isDraft',
      'headOid',
      'headRefName',
      'number',
      'author.login',
    ]);
  });

  test('refuses a duplicate PR number rather than merging two identities', () => {
    expect(
      selectAddressMany(
        listing([facts({ number: 7 }), facts({ number: 7, headOid: HEAD_B })]),
        policy(),
      ),
    ).toEqual({ ok: false, refusal: { kind: 'duplicate-pr', numbers: [7] } });
  });

  test('keeps one branch on two PR numbers as two candidates with their own heads', () => {
    const candidates = selected([
      facts({ number: 5, headRefName: 'feat/shared', headOid: HEAD_A }),
      facts({ number: 6, headRefName: 'feat/shared', headOid: HEAD_B }),
    ]);
    expect(
      candidates.map((candidate) => [candidate.number, candidate.headRefName, candidate.headOid]),
    ).toEqual([
      [5, 'feat/shared', HEAD_A],
      [6, 'feat/shared', HEAD_B],
    ]);
  });

  test('rejects malformed policy as a programmer error', () => {
    expect(() => selectAddressMany(listing([]), { repo: 'no-slash', owner: 'owner' })).toThrow(
      /owner\/name/,
    );
    expect(() => selectAddressMany(listing([]), { repo: REPO, owner: '' })).toThrow(/owner login/);
    expect(() => selectAddressMany(listing([]), policy({ viewer: ' ' }))).toThrow(/viewer/);
    expect(() => selectAddressMany(listing([]), policy({ botLogins: [''] }))).toThrow(/botLogins/);
  });
});

describe('resolveAddressManyConcurrency', () => {
  test('defaults to three as planning data and rejects non-positive or fractional values', () => {
    expect(DEFAULT_ADDRESS_MANY_CONCURRENCY).toBe(3);
    expect(resolveAddressManyConcurrency()).toBe(3);
    expect(resolveAddressManyConcurrency(5)).toBe(5);
    for (const value of [0, -1, 1.5, Number.NaN])
      expect(() => resolveAddressManyConcurrency(value)).toThrow();
  });
});
