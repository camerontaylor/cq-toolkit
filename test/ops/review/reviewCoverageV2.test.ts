import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ReviewCoverageV2Schema,
  isCoverageV2Complete,
  type ReviewCoverageV2,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const EMPTY_HASH = hash('');
const TEXT = 'abcdefghij';

type Piece = ReviewCoverageV2['pieces'][number];
type Session = ReviewCoverageV2['sessions'][number];
type Delivery = Session['deliveries'][number];

const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 };

function piece(text: string, over: Partial<Piece> = {}): Piece {
  return {
    component: 'tracked:a',
    path: 'src/a.ts',
    sha256: hash(text),
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    state: 'planned',
    ...over,
  };
}

function delivery(
  component: string,
  text: string,
  start: number,
  end: number,
  sha256 = hash(text.slice(start, end)),
): Delivery {
  return { component, start, end, sha256 };
}

function session(id: string, deliveries: Delivery[], over: Partial<Session> = {}): Session {
  return {
    id,
    status: 'complete',
    usage,
    deliveries,
    requests: deliveries.length > 0 ? [{ serializedChars: 12, decodedChars: 10 }] : [],
    ...over,
  };
}

function coverage(over: Partial<ReviewCoverageV2> = {}): ReviewCoverageV2 {
  return {
    version: 2,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    mode: 'session',
    modeReason: 'input fits the session budget',
    pieces: [],
    sessions: [],
    ...over,
  };
}

function sessionMode(): ReviewCoverageV2 {
  return coverage({
    pieces: [piece(TEXT, { state: 'completed', sessionId: 's1' })],
    sessions: [session('s1', [delivery('tracked:a', TEXT, 0, TEXT.length)])],
  });
}

function partitioned(): ReviewCoverageV2 {
  return coverage({
    mode: 'partitioned',
    modeReason: 'over session input budget',
    pieces: [piece(TEXT, { state: 'completed' })],
    sessions: [
      session('s1', [delivery('tracked:a', TEXT, 0, 4)]),
      session('s2', [delivery('tracked:a', TEXT, 4, 7)]),
      session('s3', [delivery('tracked:a', TEXT, 7, TEXT.length)]),
    ],
  });
}

const clone = (value: ReviewCoverageV2): ReviewCoverageV2 => structuredClone(value);
const parse = (value: unknown) => ReviewCoverageV2Schema.safeParse(value);

function expectInvalidMessage(value: unknown, fragment: string): void {
  const result = parse(value);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toEqual(
    expect.arrayContaining([expect.stringContaining(fragment)]),
  );
}

describe('review coverage v2 schema', () => {
  it('records unavailable search as capability evidence without changing completeness', () => {
    const value = sessionMode();
    value.sessions[0]!.capabilities = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' },
    };
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(true);
    value.sessions[0]!.status = 'error';
    expect(isCoverageV2Complete(value)).toBe(false);
  });

  it('accepts complete session-mode and partitioned evidence', () => {
    for (const value of [sessionMode(), partitioned()]) {
      expect(parse(value).success).toBe(true);
      expect(isCoverageV2Complete(value)).toBe(true);
    }
  });

  it('rejects unknown keys, missing fields and invalid enums', () => {
    const cases: [string, (value: ReviewCoverageV2) => void][] = [
      [
        'an unknown top-level key',
        (value) => {
          (value as unknown as { extra: boolean }).extra = true;
        },
      ],
      [
        'a missing version',
        (value) => {
          delete (value as { version?: number }).version;
        },
      ],
      [
        'the legacy version',
        (value) => {
          (value as { version: number }).version = 1;
        },
      ],
      [
        'a missing modeReason',
        (value) => {
          delete (value as { modeReason?: string }).modeReason;
        },
      ],
      [
        'an empty modeReason',
        (value) => {
          value.modeReason = '';
        },
      ],
      [
        'an unknown mode',
        (value) => {
          (value as unknown as { mode: string }).mode = 'hybrid';
        },
      ],
      [
        'an unknown scope',
        (value) => {
          (value as unknown as { scope: string }).scope = 'partial';
        },
      ],
      [
        'an unknown piece key',
        (value) => {
          (value.pieces[0] as unknown as { extra: boolean }).extra = true;
        },
      ],
      [
        'an unknown piece state',
        (value) => {
          (value.pieces[0] as unknown as { state: string }).state = 'sent';
        },
      ],
      [
        'a malformed piece hash',
        (value) => {
          value.pieces[0]!.sha256 = 'not-a-hash';
        },
      ],
      [
        'a negative piece count',
        (value) => {
          value.pieces[0]!.chars = -1;
        },
      ],
      [
        'an empty component name',
        (value) => {
          value.pieces[0]!.component = '';
        },
      ],
      [
        'a duplicate component',
        (value) => {
          value.pieces.push(structuredClone(value.pieces[0]!));
        },
      ],
      [
        'an empty piece list',
        (value) => {
          value.pieces = [];
          value.sessions = [];
        },
      ],
      [
        'an unknown session key',
        (value) => {
          (value.sessions[0] as unknown as { extra: boolean }).extra = true;
        },
      ],
      [
        'an unknown session status',
        (value) => {
          (value.sessions[0] as unknown as { status: string }).status = 'sent';
        },
      ],
      [
        'an empty session id',
        (value) => {
          value.sessions[0]!.id = '';
        },
      ],
      [
        'duplicate session ids',
        (value) => {
          value.sessions.push(session(value.sessions[0]!.id, [], { status: 'error' }));
        },
      ],
      [
        'a negative usage count',
        (value) => {
          value.sessions[0]!.usage.input = -1;
        },
      ],
      [
        'a negative steps count',
        (value) => {
          value.sessions[0]!.steps = -1;
        },
      ],
      [
        'an unknown request key',
        (value) => {
          (value.sessions[0]!.requests[0] as unknown as { extra: boolean }).extra = true;
        },
      ],
      [
        'an unknown delivery key',
        (value) => {
          (value.sessions[0]!.deliveries[0] as unknown as { extra: boolean }).extra = true;
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const value = clone(sessionMode());
      mutate(value);
      expect(parse(value).success, name).toBe(false);
    }
  });

  it('accounts for a completed component split across contiguous sessions', () => {
    const value = partitioned();
    expect(value.pieces[0]?.sessionId).toBeUndefined();
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(true);
  });

  it('allows one session to deliver multiple complete components', () => {
    const other = '0123456789';
    const value = coverage({
      pieces: [
        piece(TEXT, { state: 'completed', sessionId: 's1' }),
        piece(other, {
          component: 'tracked:b',
          path: 'src/b.ts',
          state: 'completed',
          sessionId: 's1',
        }),
      ],
      sessions: [
        session('s1', [
          delivery('tracked:a', TEXT, 0, TEXT.length),
          delivery('tracked:b', other, 0, other.length),
        ]),
      ],
    });
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(true);
  });

  it('rejects gaps, overlaps and repeated deliveries', () => {
    const gap = partitioned();
    gap.sessions[1]!.deliveries[0]!.start = 5;
    expectInvalidMessage(gap, 'completed component needs complete, contiguous session coverage');

    const overlap = partitioned();
    overlap.sessions[1]!.deliveries[0] = delivery('tracked:a', TEXT, 3, 7);
    expectInvalidMessage(overlap, 'review deliveries overlap or repeat');

    const repeat = partitioned();
    repeat.sessions[2]!.deliveries[0] = delivery('tracked:a', TEXT, 4, 7);
    expectInvalidMessage(repeat, 'review deliveries overlap or repeat');

    const sameSessionRepeat = partitioned();
    sameSessionRepeat.sessions[1]!.deliveries = [
      delivery('tracked:a', TEXT, 4, 7),
      delivery('tracked:a', TEXT, 4, 7),
    ];
    sameSessionRepeat.sessions.splice(2, 1);
    expectInvalidMessage(sameSessionRepeat, 'review deliveries overlap or repeat');
  });

  it('poisons a completed component when any delivering session did not complete', () => {
    const value = partitioned();
    value.sessions[1]!.status = 'budget';
    expectInvalidMessage(value, 'completed component needs complete, contiguous session coverage');
  });

  it('keeps failed non-delivering sessions as blocking incomplete evidence', () => {
    const value = sessionMode();
    value.sessions.push(session('s2', [], { status: 'error' }));
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(false);
  });

  it('allows partial no-gap evidence as delivered but never complete', () => {
    const value = coverage({
      pieces: [piece(TEXT, { state: 'delivered', sessionId: 's1' })],
      sessions: [session('s1', [delivery('tracked:a', TEXT, 0, 4)])],
    });
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(false);
  });

  it('rejects a completed state without the whole component', () => {
    const value = coverage({
      pieces: [piece(TEXT, { state: 'completed', sessionId: 's1' })],
      sessions: [session('s1', [delivery('tracked:a', TEXT, 0, 4)])],
    });
    expectInvalidMessage(value, 'completed component needs complete, contiguous session coverage');
  });

  it('does not let a delivered state claim completion even with full coverage', () => {
    const value = sessionMode();
    value.pieces[0]!.state = 'delivered';
    expect(parse(value).success).toBe(true);
    expect(isCoverageV2Complete(value)).toBe(false);
  });

  it('enforces planned, delivered and excluded evidence rules', () => {
    const plannedWithDelivery = sessionMode();
    plannedWithDelivery.pieces[0]!.state = 'planned';
    expectInvalidMessage(plannedWithDelivery, 'planned components have no deliveries');

    const deliveredWithoutDelivery = coverage({
      pieces: [piece(TEXT, { state: 'delivered' })],
    });
    expectInvalidMessage(deliveredWithoutDelivery, 'planned components have no deliveries');

    const excludedWithDelivery = sessionMode();
    excludedWithDelivery.pieces[0] = piece(TEXT, {
      state: 'excluded',
      exclusion: { rule: 'generated/**', assuredBy: 'dev.check' },
    });
    expectInvalidMessage(
      excludedWithDelivery,
      'excluded component must have an exclusion and no deliveries',
    );

    const excludedWithoutRule = coverage({
      pieces: [piece(TEXT, { state: 'excluded' })],
    });
    expectInvalidMessage(excludedWithoutRule, 'excluded component must have an exclusion');

    const unassured = coverage({
      pieces: [piece(TEXT, { state: 'excluded', exclusion: { rule: 'generated/**' } })],
    });
    expectInvalidMessage(unassured, 'unassured exclusion must state its limitation');

    const nonExcludedWithExclusion = coverage({
      pieces: [piece(TEXT, { exclusion: { rule: 'generated/**', assuredBy: 'dev.check' } })],
    });
    expectInvalidMessage(nonExcludedWithExclusion, 'only excluded components may have exclusions');
  });

  it('accepts assured and limitation-only exclusions, including an all-excluded review', () => {
    const assured = coverage({
      pieces: [
        piece(TEXT, {
          state: 'excluded',
          exclusion: { rule: 'generated/**', assuredBy: 'dev.check lockfile integrity' },
        }),
      ],
    });
    const limited = coverage({
      pieces: [
        piece(TEXT, {
          state: 'excluded',
          exclusion: {
            rule: 'generated/**',
            limitation: 'not covered by an automated check',
          },
        }),
      ],
    });
    for (const value of [assured, limited]) {
      expect(parse(value).success).toBe(true);
      expect(isCoverageV2Complete(value)).toBe(true);
    }
  });

  it('mirrors the single delivering session and omits the mirror when split', () => {
    const single = sessionMode();
    single.pieces[0]!.sessionId = 's2';
    expectInvalidMessage(single, 'piece sessionId must reflect its delivering sessions');

    const missing = sessionMode();
    delete missing.pieces[0]!.sessionId;
    expectInvalidMessage(missing, 'piece sessionId must reflect its delivering sessions');

    const split = partitioned();
    split.pieces[0]!.sessionId = 's1';
    expectInvalidMessage(split, 'piece sessionId must reflect its delivering sessions');

    const oneSessionTwoRanges = coverage({
      pieces: [piece(TEXT, { state: 'completed', sessionId: 's1' })],
      sessions: [
        session('s1', [
          delivery('tracked:a', TEXT, 0, 4),
          delivery('tracked:a', TEXT, 4, TEXT.length),
        ]),
      ],
    });
    expect(parse(oneSessionTwoRanges).success).toBe(true);
    expect(isCoverageV2Complete(oneSessionTwoRanges)).toBe(true);
  });

  it('rejects deliveries for unknown components and out-of-bounds or empty ranges', () => {
    const unknown = sessionMode();
    unknown.sessions[0]!.deliveries[0]!.component = 'tracked:missing';
    expectInvalidMessage(unknown, 'invalid review delivery range');

    const outOfBounds = sessionMode();
    outOfBounds.sessions[0]!.deliveries[0]!.end = TEXT.length + 1;
    expectInvalidMessage(outOfBounds, 'invalid review delivery range');

    const backwards = sessionMode();
    backwards.sessions[0]!.deliveries[0]!.start = 5;
    backwards.sessions[0]!.deliveries[0]!.end = 4;
    expectInvalidMessage(backwards, 'invalid review delivery range');

    const emptyRange = sessionMode();
    emptyRange.sessions[0]!.deliveries[0] = delivery('tracked:a', TEXT, 3, 3);
    expectInvalidMessage(emptyRange, 'invalid review delivery range');
  });

  it('requires the whole-component delivery hash to match the plan', () => {
    const value = sessionMode();
    value.sessions[0]!.deliveries[0]!.sha256 = hash('different');
    expectInvalidMessage(value, 'whole-component delivery hash does not match its plan');
  });

  it('accepts a split-range hash as audit data', () => {
    const value = coverage({
      pieces: [piece(TEXT, { state: 'delivered', sessionId: 's1' })],
      sessions: [session('s1', [delivery('tracked:a', TEXT, 0, 4, hash('any-split-bytes'))])],
    });
    expect(parse(value).success).toBe(true);
  });

  it('requires empty components to carry the empty identity and exactly one delivery', () => {
    const valid = coverage({
      pieces: [piece('', { state: 'completed', sessionId: 's1' })],
      sessions: [session('s1', [{ component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH }])],
    });
    expect(parse(valid).success).toBe(true);
    expect(isCoverageV2Complete(valid)).toBe(true);

    const repeated = coverage({
      pieces: [piece('', { state: 'completed', sessionId: 's1' })],
      sessions: [
        session('s1', [
          { component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH },
          { component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH },
        ]),
      ],
    });
    expectInvalidMessage(repeated, 'review deliveries overlap or repeat');

    const twoSessions = coverage({
      pieces: [piece('', { state: 'completed' })],
      sessions: [
        session('s1', [{ component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH }]),
        session('s2', [{ component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH }]),
      ],
    });
    expectInvalidMessage(twoSessions, 'review deliveries overlap or repeat');

    const wrongBytes = coverage({
      pieces: [piece('', { state: 'excluded', exclusion: { rule: 'x', assuredBy: 'y' } })],
    });
    wrongBytes.pieces[0]!.bytes = 1;
    expectInvalidMessage(wrongBytes, 'empty component must have the empty-content identity');

    const wrongHash = coverage({
      pieces: [piece('', { state: 'excluded', exclusion: { rule: 'x', assuredBy: 'y' } })],
    });
    wrongHash.pieces[0]!.sha256 = hash('not-empty');
    expectInvalidMessage(wrongHash, 'empty component must have the empty-content identity');

    const noDelivery = coverage({ pieces: [piece('', { state: 'completed' })] });
    expectInvalidMessage(noDelivery, 'planned components have no deliveries');

    const deliveredEmpty = coverage({
      pieces: [piece('', { state: 'delivered', sessionId: 's1' })],
      sessions: [session('s1', [{ component: 'tracked:a', start: 0, end: 0, sha256: EMPTY_HASH }])],
    });
    expect(parse(deliveredEmpty).success).toBe(true);
    expect(isCoverageV2Complete(deliveredEmpty)).toBe(false);

    const excludedEmpty = coverage({
      pieces: [piece('', { state: 'excluded', exclusion: { rule: 'x', assuredBy: 'y' } })],
    });
    expect(parse(excludedEmpty).success).toBe(true);
    expect(isCoverageV2Complete(excludedEmpty)).toBe(true);
  });

  it('rejects a complete session that delivered nothing and deliveries without a request', () => {
    const noDelivery = coverage({
      pieces: [piece(TEXT)],
      sessions: [session('s1', [], { status: 'complete' })],
    });
    expectInvalidMessage(noDelivery, 'a complete review session must deliver content');

    const noRequest = sessionMode();
    noRequest.sessions[0]!.requests = [];
    expectInvalidMessage(noRequest, 'review delivery needs a scanned request');

    for (const status of ['budget', 'error', 'aborted'] as const) {
      const failed = coverage({
        pieces: [piece(TEXT)],
        sessions: [session('s1', [], { status })],
      });
      expect(parse(failed).success).toBe(true);
      expect(isCoverageV2Complete(failed)).toBe(false);
    }
  });

  it('counts only completed or excluded pieces with every session complete', () => {
    const mixed = coverage({
      pieces: [
        piece(TEXT, { component: 'tracked:a', state: 'completed', sessionId: 's1' }),
        piece('other', {
          component: 'untracked:b',
          state: 'excluded',
          exclusion: { rule: 'generated/**', assuredBy: 'dev.check' },
        }),
      ],
      sessions: [session('s1', [delivery('tracked:a', TEXT, 0, TEXT.length)])],
    });
    expect(isCoverageV2Complete(mixed)).toBe(true);

    const planned = coverage({ pieces: [piece(TEXT)] });
    expect(isCoverageV2Complete(planned)).toBe(false);

    const withFailedSession = sessionMode();
    withFailedSession.sessions.push(session('s2', [], { status: 'aborted' }));
    expect(parse(withFailedSession).success).toBe(true);
    expect(isCoverageV2Complete(withFailedSession)).toBe(false);

    expect(isCoverageV2Complete({ ...sessionMode(), pieces: [] })).toBe(false);
  });
});
