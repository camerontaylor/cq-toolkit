// W1.9 — the D11 cq-override label record (ADR-0004 D-G.4), including the
// A14 regression: a label applied through an App token is never an owner
// override, attested or not. Also the shared D11 authorization predicate
// (d11Authorization.ts, ADR-0004 D-C.3) the gate and the verifier bind.
import { describe, expect, test } from 'vitest';
import {
  authorizePaths,
  bindD11Authorization,
  type D11PrEvidence,
} from '../../../src/ops/gates/d11Authorization.js';
import {
  C3_ATTESTATION_PATH,
  OVERRIDE_LABEL,
  evaluateOverrideLabel,
  formatOverride,
  headObservationEpoch,
  headObservationEpochInHistory,
  parseC3Attestation,
} from '../../../src/ops/gates/overrideRecord.js';
import type { SettleState } from '../../../src/selfhost/settle-state.js';

const OWNER_ID = 1001;
const SUBJECT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const EPOCH = '2026-09-20T10:00:00.000Z';

interface EventOpts {
  event?: string;
  label?: string;
  login?: string;
  id?: number;
  type?: string;
  app?: { slug: string } | null;
  at?: string;
}

function labelEvent(opts: EventOpts = {}): Record<string, unknown> {
  return {
    id: 1,
    event: opts.event ?? 'labeled',
    label: { name: opts.label ?? OVERRIDE_LABEL, color: 'ff0000' },
    actor: {
      login: opts.login ?? 'owner',
      id: opts.id ?? OWNER_ID,
      type: opts.type ?? 'User',
      site_admin: false,
    },
    created_at: opts.at ?? '2026-09-20T11:00:00Z',
    performed_via_github_app: opts.app === undefined ? null : opts.app,
  };
}

const evaluate = (
  events: readonly unknown[],
  over: Partial<{ headObservedAt: string | undefined; attested: boolean; ownerId: number }> = {},
) =>
  evaluateOverrideLabel({
    events,
    ownerId: over.ownerId ?? OWNER_ID,
    subject: SUBJECT,
    headObservedAt: 'headObservedAt' in over ? over.headObservedAt : EPOCH,
    attested: over.attested ?? false,
  });

describe('headObservationEpoch', () => {
  const settle: SettleState = {
    version: 1,
    repo: 'o/r',
    prs: {
      '7': {
        tuple: { head: SUBJECT, base: BASE, forcePushEpoch: 0 },
        observations: [
          { observedAt: EPOCH, by: 'a' },
          { observedAt: '2026-09-21T10:00:00.000Z', by: 'b' },
        ],
      },
      '8': {
        tuple: { head: 'c'.repeat(40), base: BASE, forcePushEpoch: 0 },
        observations: [{ observedAt: EPOCH, by: 'a' }],
      },
      '9': { tuple: { head: SUBJECT, base: BASE, forcePushEpoch: 0 }, observations: [] },
    },
  };

  test('returns the FIRST observation of the record whose head is the subject', () => {
    expect(headObservationEpoch(settle, 7, SUBJECT)).toBe(EPOCH);
  });

  test('a record for a different head gives no epoch', () => {
    expect(headObservationEpoch(settle, 8, SUBJECT)).toBeUndefined();
  });

  test('no record, or a record without observations, gives no epoch', () => {
    expect(headObservationEpoch(settle, 42, SUBJECT)).toBeUndefined();
    expect(headObservationEpoch(settle, 9, SUBJECT)).toBeUndefined();
  });
});

describe('evaluateOverrideLabel', () => {
  test('no events is absent', () => {
    expect(evaluate([])).toEqual({ status: 'absent', reasons: [] });
  });

  test('other labels, other events and non-objects are ignored', () => {
    expect(
      evaluate([
        labelEvent({ label: 'CQ-Override' }),
        labelEvent({ label: 'cq-override ' }),
        { event: 'commented', label: { name: OVERRIDE_LABEL } },
        { event: 'labeled' },
        { event: 'labeled', label: null },
        null,
        'labeled',
        42,
      ]),
    ).toEqual({ status: 'absent', reasons: [] });
  });

  test('a valid owner label after the epoch is dormant when not attested', () => {
    const result = evaluate([labelEvent()]);
    expect(result.status).toBe('dormant');
    expect(result.reasons).toEqual([]);
    expect(result.event).toEqual({
      actorLogin: 'owner',
      actorId: OWNER_ID,
      actorType: 'User',
      viaApp: null,
      createdAt: '2026-09-20T11:00:00Z',
    });
  });

  test('a valid owner label after the epoch is honoured when attested', () => {
    expect(evaluate([labelEvent()], { attested: true }).status).toBe('honoured');
  });

  test('A14: an App-token label (Bot via cq-automation) is invalid even when attested', () => {
    const result = evaluate(
      [labelEvent({ login: 'cq-automation[bot]', type: 'Bot', app: { slug: 'cq-automation' } })],
      { attested: true },
    );
    expect(result.status).toBe('invalid');
    expect(result.event?.viaApp).toBe('cq-automation');
    expect(result.reasons.join('\n')).toMatch(/type 'Bot' is not 'User'/);
    expect(result.reasons.join('\n')).toMatch(/via GitHub App 'cq-automation'/);
  });

  test('A14: an App-performed label is invalid even with the owner as actor', () => {
    const result = evaluate([labelEvent({ app: { slug: 'some-app' } })], { attested: true });
    expect(result.status).toBe('invalid');
    expect(result.reasons).toHaveLength(1);
  });

  test('an owner PAT/web-UI label BEFORE the head epoch is invalid', () => {
    const result = evaluate([labelEvent({ at: '2026-09-20T09:59:59Z' })], { attested: true });
    expect(result.status).toBe('invalid');
    expect(result.reasons[0]).toMatch(/not after the head observation epoch/);
  });

  test('a label at the epoch second is not strictly after it', () => {
    const result = evaluate([labelEvent({ at: '2026-09-20T10:00:00Z' })], {
      headObservedAt: '2026-09-20T10:00:00.000Z',
      attested: true,
    });
    expect(result.status).toBe('invalid');
  });

  test('no durable head observation is invalid', () => {
    const result = evaluate([labelEvent()], { headObservedAt: undefined, attested: true });
    expect(result.status).toBe('invalid');
    expect(result.reasons).toEqual([`no durable head observation for ${SUBJECT}`]);
  });

  test('an unparseable head epoch is invalid', () => {
    expect(evaluate([labelEvent()], { headObservedAt: 'nope', attested: true }).status).toBe(
      'invalid',
    );
  });

  test('an ownerId mismatch is invalid', () => {
    const result = evaluate([labelEvent({ id: 2002, login: 'someone' })], { attested: true });
    expect(result.status).toBe('invalid');
    expect(result.reasons).toEqual([`actor id 2002 is not the repository owner id ${OWNER_ID}`]);
  });

  test('label then unlabel is absent', () => {
    expect(evaluate([labelEvent(), labelEvent({ event: 'unlabeled' })])).toEqual({
      status: 'absent',
      reasons: [],
    });
  });

  test('an unlabel of a different label does not remove the override', () => {
    expect(
      evaluate([labelEvent(), labelEvent({ event: 'unlabeled', label: 'other' })]).status,
    ).toBe('dormant');
  });

  test('unlabel then relabel by the owner after the epoch: dormant, honoured when attested', () => {
    const events = [
      labelEvent({ login: 'cq-automation[bot]', type: 'Bot', app: { slug: 'cq-automation' } }),
      labelEvent({ event: 'unlabeled', at: '2026-09-20T11:30:00Z' }),
      labelEvent({ at: '2026-09-20T12:00:00Z' }),
    ];
    expect(evaluate(events).status).toBe('dormant');
    expect(evaluate(events, { attested: true }).status).toBe('honoured');
  });

  test('the LAST application is judged: a bad relabel after a good one is invalid', () => {
    const events = [
      labelEvent(),
      labelEvent({ event: 'unlabeled', at: '2026-09-20T11:30:00Z' }),
      labelEvent({ type: 'Bot', app: { slug: 'x' }, at: '2026-09-20T12:00:00Z' }),
    ];
    expect(evaluate(events, { attested: true }).status).toBe('invalid');
  });

  describe('malformed current application fails closed', () => {
    const base = labelEvent();
    test.each([
      ['missing performed_via_github_app', { ...base, performed_via_github_app: undefined }],
      ['performed_via_github_app without slug', { ...base, performed_via_github_app: {} }],
      ['performed_via_github_app as string', { ...base, performed_via_github_app: 'x' }],
      ['missing actor', { ...base, actor: undefined }],
      ['string actor id', { ...base, actor: { login: 'owner', id: '1001', type: 'User' } }],
      ['zero actor id', { ...base, actor: { login: 'owner', id: 0, type: 'User' } }],
      ['fractional actor id', { ...base, actor: { login: 'owner', id: 1.5, type: 'User' } }],
      ['missing actor type', { ...base, actor: { login: 'owner', id: OWNER_ID } }],
      ['ms-precision created_at', { ...base, created_at: '2026-09-20T11:00:00.000Z' }],
      ['offset created_at', { ...base, created_at: '2026-09-20T11:00:00+00:00' }],
      ['impossible date', { ...base, created_at: '2026-02-30T11:00:00Z' }],
      ['numeric created_at', { ...base, created_at: 1_790_000_000 }],
    ])('%s is invalid', (_label, event) => {
      const result = evaluate([event], { attested: true });
      expect(result.status).toBe('invalid');
      expect(result.event).toBeUndefined();
      expect(result.reasons[0]).toMatch(/^malformed cq-override labeled event/);
    });
  });

  test('never throws on hostile input', () => {
    const events: unknown[] = [
      undefined,
      [],
      { event: 'labeled', label: { name: OVERRIDE_LABEL }, actor: null },
    ];
    expect(() => evaluate(events)).not.toThrow();
    expect(evaluate(events).status).toBe('invalid');
  });
});

describe('formatOverride', () => {
  test('absent is a single line', () => {
    expect(formatOverride({ status: 'absent', reasons: [] })).toEqual([
      'override: absent (no cq-override label)',
    ]);
  });

  test('dormant lists every checked field and the C3 note', () => {
    const lines = formatOverride(evaluate([labelEvent()]));
    expect(lines).toEqual([
      'override: cq-override label present',
      '  actor.login: owner',
      `  actor.id: ${OWNER_ID}`,
      '  actor.type: User',
      '  via-app: none',
      '  created_at: 2026-09-20T11:00:00Z',
      '  verdict: dormant',
      `  dormant: ADR-0004 D-G.4 records are honoured only once the C3 attestation (${C3_ATTESTATION_PATH}) is on the trust ref`,
    ]);
  });

  test('invalid lists the via-app slug and every reason', () => {
    const lines = formatOverride(
      evaluate([labelEvent({ type: 'Bot', app: { slug: 'cq-automation' } })], { attested: true }),
    );
    expect(lines).toContain('  via-app: cq-automation');
    expect(lines).toContain('  verdict: invalid');
    expect(lines.filter((line) => line.startsWith('  reason: '))).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/dormant:/);
  });

  test('malformed invalid still reports the verdict and reason', () => {
    const lines = formatOverride(evaluate([{ ...labelEvent(), actor: 'x' }]));
    expect(lines[0]).toBe('override: cq-override label present');
    expect(lines).toContain('  verdict: invalid');
  });

  test('honoured carries no dormant note', () => {
    const lines = formatOverride(evaluate([labelEvent()], { attested: true }));
    expect(lines).toContain('  verdict: honoured');
    expect(lines.join('\n')).not.toMatch(/dormant:/);
  });

  test('control characters in API strings are neutralised', () => {
    const lines = formatOverride(evaluate([labelEvent({ login: 'ev\nil\u001b[31m' })]));
    expect(lines).toContain('  actor.login: ev?il?[31m');
  });
});

describe('parseC3Attestation: presence alone never arms D-G.4 records (composition F5)', () => {
  const valid = { schemaVersion: 1, attests: 'C3', attestedAt: '2026-09-26T00:00:00Z' };

  test('the exact shape arms', () => {
    expect(parseC3Attestation(JSON.stringify(valid))).toEqual({ armed: true });
    expect(parseC3Attestation(JSON.stringify({ ...valid, note: 'PATs revoked' }))).toEqual({
      armed: true,
    });
  });

  test.each([
    ['empty file', ''],
    ['empty object', '{}'],
    ['placeholder text', 'TODO'],
    ['wrong attests', JSON.stringify({ ...valid, attests: 'C2' })],
    ['wrong version', JSON.stringify({ ...valid, schemaVersion: 2 })],
    ['non-canonical time', JSON.stringify({ ...valid, attestedAt: '2026-09-26' })],
    ['an extra key', JSON.stringify({ ...valid, armed: true })],
  ])('%s stays dormant', (_label, text) => {
    expect(parseC3Attestation(text).armed).toBe(false);
  });
});

describe('headObservationEpochInHistory (merged PRs are pruned from the ledger tip)', () => {
  const version = (prs: Record<string, string>): SettleState => ({
    version: 1,
    repo: 'o/r',
    prs: Object.fromEntries(
      Object.entries(prs).map(([pr, head]) => [
        pr,
        {
          tuple: { head, base: BASE, forcePushEpoch: 0 },
          observations: [{ observedAt: EPOCH, by: 'observer' }],
        },
      ]),
    ),
  });

  test('the newest version holding the PR decides; a pruned tip falls through to it', () => {
    expect(
      headObservationEpochInHistory([version({}), version({ '7': SUBJECT })], 7, SUBJECT),
    ).toBe(EPOCH);
  });

  test('a newer record of another head wins over an older one of this head (no stale anchor)', () => {
    const history = [version({ '7': 'c'.repeat(40) }), version({ '7': SUBJECT })];
    expect(headObservationEpochInHistory(history, 7, SUBJECT)).toBeUndefined();
  });

  test('no version holding the PR (or no ledger at all) → no epoch', () => {
    expect(headObservationEpochInHistory([version({ '8': SUBJECT })], 7, SUBJECT)).toBeUndefined();
    expect(headObservationEpochInHistory([], 7, SUBJECT)).toBeUndefined();
  });
});

describe('D11 authorization (bindD11Authorization + authorizePaths)', () => {
  const C3 = JSON.stringify({
    schemaVersion: 1,
    attests: 'C3',
    attestedAt: '2026-10-01T00:00:00Z',
  });
  const evidence = (over: Partial<D11PrEvidence> = {}): D11PrEvidence => ({
    pr: 7,
    merge: 'c'.repeat(40),
    head: SUBJECT,
    paths: ['vitest.config.ts'],
    events: [labelEvent()],
    headObservedAt: EPOCH,
    ...over,
  });
  const bind = (
    prs: readonly D11PrEvidence[],
    attestation: Parameters<typeof bindD11Authorization>[0]['attestation'] = {
      state: 'present',
      text: C3,
    },
    ownerId: number | null = OWNER_ID,
  ) => bindD11Authorization({ ownerId, attestation, prs });

  test('a valid record with C3 attested authorizes the path its PR changed', () => {
    const auth = bind([evidence()]);
    expect(auth.attested).toBe(true);
    expect(auth.contributions[0]?.record.status).toBe('honoured');
    const d = authorizePaths(auth, ['vitest.config.ts']);
    expect(d).toMatchObject({ authorized: true, unauthorized: [] });
    expect(d.lines).toEqual(['d11: vitest.config.ts authorized by PR #7']);
  });

  test('no attestation, or a malformed or unreadable one → dormant, unauthorized', () => {
    for (const attestation of [
      { state: 'absent' } as const,
      { state: 'present', text: '{"schemaVersion":1}' } as const,
      { state: 'unreadable', reason: 'git fault' } as const,
    ]) {
      const auth = bind([evidence()], attestation);
      expect(auth.attested).toBe(false);
      expect(auth.contributions[0]?.record.status).toBe('dormant');
      expect(auth.report.join('\n')).toMatch(/records dormant/);
      expect(authorizePaths(auth, ['vitest.config.ts']).unauthorized).toEqual([
        {
          path: 'vitest.config.ts',
          why: `PR #7 (merge ${'c'.repeat(40)}) changes it and its D11 record is dormant`,
        },
      ]);
    }
  });

  test('a label before the epoch, or with no epoch, is invalid', () => {
    const early = bind([evidence({ events: [labelEvent({ at: '2026-09-20T09:00:00Z' })] })]);
    expect(early.contributions[0]?.record.status).toBe('invalid');
    expect(authorizePaths(early, ['vitest.config.ts']).authorized).toBe(false);
    const none = bind([evidence({ headObservedAt: undefined })]);
    expect(none.contributions[0]?.record.reasons).toEqual([
      `no durable head observation for ${SUBJECT}`,
    ]);
  });

  test('an App-applied label is invalid even when attested (A14)', () => {
    const auth = bind([
      evidence({ events: [labelEvent({ app: { slug: 'cq-automation' }, type: 'Bot', id: 9 })] }),
    ]);
    expect(auth.contributions[0]?.record.status).toBe('invalid');
    expect(authorizePaths(auth, ['vitest.config.ts']).authorized).toBe(false);
  });

  test('a path no contribution changes (outside the closure) is named', () => {
    const d = authorizePaths(bind([evidence()]), ['vitest.config.ts', 'ci.yml']);
    expect(d.authorized).toBe(false);
    expect(d.unauthorized).toEqual([
      { path: 'ci.yml', why: 'not contributed by any admitted PR in the closure' },
    ]);
  });

  test('one label never authorizes another PR that changed the same path', () => {
    const other = evidence({ pr: 8, merge: 'd'.repeat(40), events: [] });
    const d = authorizePaths(bind([evidence(), other]), ['vitest.config.ts']);
    expect(d.authorized).toBe(false);
    expect(d.unauthorized).toEqual([
      {
        path: 'vitest.config.ts',
        why: `PR #8 (merge ${'d'.repeat(40)}) changes it and its D11 record is absent`,
      },
    ]);
  });

  test('ambiguous contributions, an unreadable owner id or unreadable events are invalid', () => {
    const twice = bind([evidence(), evidence({ pr: 8 })]);
    expect(twice.contributions.map((c) => c.record.status)).toEqual(['invalid', 'invalid']);
    expect(twice.contributions[0]?.record.reasons[0]).toMatch(/^ambiguous: /);
    const noOwner = bind([evidence()], undefined, null);
    expect(noOwner.contributions[0]?.record.reasons).toEqual(['repository owner id unreadable']);
    const noEvents = bind([evidence({ events: { unreadable: 'HTTP 502' } })]);
    expect(noEvents.contributions[0]?.record.reasons).toEqual([
      'label events unreadable: HTTP 502',
    ]);
  });

  test('nothing to authorize is authorized', () => {
    expect(authorizePaths(bind([]), [])).toEqual({ authorized: true, unauthorized: [], lines: [] });
  });
});
