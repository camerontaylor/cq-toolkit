// W1.9 — the D11 cq-override label record (ADR-0004 D-G.4), including the
// A14 regression: a label applied through an App token is never an owner
// override, attested or not.
import { describe, expect, test } from 'vitest';
import {
  C3_ATTESTATION_PATH,
  OVERRIDE_LABEL,
  evaluateOverrideLabel,
  formatOverride,
  headObservationEpoch,
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
