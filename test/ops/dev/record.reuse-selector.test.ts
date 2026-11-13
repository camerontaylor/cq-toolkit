// record.ts unit tests — the reuse selector (Q4/#485): exact-terminal reuse and
// the no-fresh-tail resolution, including the intervening-blocker refusals.
// Readiness's use of the persisted resolution lives in
// record.readiness-reuse.test.ts.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { describe, expect, test } from 'vitest';
import { findReusableCycle } from '../../../src/ops/dev/record.js';
import { BASE, HEAD, cycleRecord } from './fakes.js';
import { NO_FRESH_REASON } from './record.helpers.js';

const REQUEST = {
  target: 'main',
  base: BASE,
  head: HEAD,
  dirtySha256: 'dirty',
  scope: 'full' as const,
  reviewer: 'coderabbit',
};

describe('findReusableCycle', () => {
  test('a later terminal resolves a blocker only at its own full identity', () => {
    const blocked = cycleRecord({
      cycleId: 'c002',
      head: 'd'.repeat(40),
      completion: { kind: 'blocked', reason: 'failed' },
    });
    // A newer SAME-identity terminal supersedes the anchor: it both resolves
    // the blocker and becomes the selection.
    const terminal = cycleRecord({ cycleId: 'c003' });
    expect(findReusableCycle([cycleRecord(), blocked, terminal], REQUEST)).toMatchObject({
      basis: 'exact-terminal',
      cycle: { cycleId: 'c003' },
    });
    // A newer terminal at a DIFFERENT identity refuses reuse: readiness
    // anchors on it and reports stale-review-identity at this tree.
    const moved = cycleRecord({ cycleId: 'c003', head: blocked.head });
    expect(findReusableCycle([cycleRecord(), blocked, moved], REQUEST)).toBeNull();
    expect(
      findReusableCycle(
        [cycleRecord(), blocked, { ...terminal, dirtySha256: 'different' }],
        REQUEST,
      ),
    ).toBeNull();
  });

  test.each([
    { scope: 'uncommitted' as const },
    { head: 'd'.repeat(40) },
    { reviewer: 'agent:critic', head: 'd'.repeat(40) },
  ])('refuses a later configured blocker across identity: %j', (identity) => {
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            ...identity,
            completion: { kind: 'blocked', reason: NO_FRESH_REASON },
          }),
        ],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('unconfigured later attempts do not prevent reuse', () => {
    for (const later of [
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        reviewer: 'other',
        head: 'd'.repeat(40),
        completion: { kind: 'terminal' },
      }),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        reviewer: 'other',
        completion: { kind: 'blocked', reason: 'failed' },
      }),
    ]) {
      expect(findReusableCycle([cycleRecord(), later], REQUEST)?.basis).toBe('exact-terminal');
    }
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            reviewer: 'agent:critic',
            completion: { kind: 'blocked', reason: 'failed' },
          }),
        ],
        { ...REQUEST, configuredReviewers: ['coderabbit'] },
      )?.basis,
    ).toBe('exact-terminal');
  });

  test('selects the exact terminal cycle at the identical identity', () => {
    const selection = findReusableCycle([cycleRecord()], REQUEST);
    expect(selection).not.toBeNull();
    expect(selection).toMatchObject({
      basis: 'exact-terminal',
      cycle: { cycleId: 'c001-aaaaaaaa' },
    });
  });

  test('no terminal cycle: null (dispatch a fresh cycle)', () => {
    expect(
      findReusableCycle(
        [cycleRecord({ completion: { kind: 'blocked', reason: 'cli exit 1' } })],
        REQUEST,
      ),
    ).toBeNull();
    expect(findReusableCycle([], REQUEST)).toBeNull();
  });

  test('dirty scope mismatch never reuses', () => {
    expect(
      findReusableCycle([cycleRecord()], { ...REQUEST, dirtySha256: 'other-dirty' }),
    ).toBeNull();
  });

  test('changed target at the same merge-base never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, target: 'release' })).toBeNull();
  });

  test('changed head or base never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, head: 'd'.repeat(40) })).toBeNull();
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, base: 'e'.repeat(40) })).toBeNull();
  });

  test('a different reviewer or scope never reuses', () => {
    expect(
      findReusableCycle([cycleRecord()], { ...REQUEST, reviewer: 'agent:reviewer' }),
    ).toBeNull();
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, scope: 'uncommitted' })).toBeNull();
  });

  test('an uncommitted-scope terminal cycle is never a reuse anchor', () => {
    expect(
      findReusableCycle([cycleRecord({ scope: 'uncommitted' })], {
        ...REQUEST,
        scope: 'uncommitted',
      }),
    ).toBeNull();
  });

  test.each([NO_FRESH_REASON, `skipped:no-fresh: ${NO_FRESH_REASON}`])(
    'the LATEST same-identity no-fresh tail yields the resolution: %s',
    (reason) => {
      const selection = findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            completion: { kind: 'blocked', reason },
          }),
        ],
        REQUEST,
      );
      expect(selection).not.toBeNull();
      expect(selection).toMatchObject({
        basis: 'no-fresh-tail',
        cycle: { cycleId: 'c001-aaaaaaaa' },
        resolvesCycleId: 'c002-aaaaaaaa',
      });
    },
  );

  test('a genuine later blocker (error/auth/kill) refuses reuse even with an earlier terminal', () => {
    for (const reason of [
      'reviewer stream carried an error event',
      'reviewer requested action (usage-limit confirmation class) — the cycle never reviewed',
      'the reviewer CLI timed out after 1500000ms and was stopped — no review completed',
      'reviewer stream was MALFORMED — 1 line(s) were unparsable or of an unrecognized event type',
    ]) {
      const selection = findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            completion: { kind: 'blocked', reason },
          }),
        ],
        REQUEST,
      );
      expect(selection, reason).toBeNull();
    }
  });

  test('an intervening genuine blocker refuses reuse even when a no-fresh tail follows it', () => {
    // The reachable sequence the selector used to resolve: terminal A -> a
    // genuine blocked attempt B with no authority to resolve it -> exact
    // affirmative no-fresh C. C is eligible in shape, but B was never
    // reviewed, so no reuse may be selected over it.
    for (const reason of [
      'reviewer stream carried an error event',
      'reviewer requested action (usage-limit confirmation class) — the cycle never reviewed',
      'the reviewer CLI timed out after 1500000ms and was stopped — no review completed',
      'reviewer stream was MALFORMED — 1 line(s) were unparsable or of an unrecognized event type',
    ]) {
      const selection = findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({ cycleId: 'c002-aaaaaaaa', completion: { kind: 'blocked', reason } }),
          cycleRecord({
            cycleId: 'c003-aaaaaaaa',
            completion: { kind: 'blocked', reason: NO_FRESH_REASON },
          }),
        ],
        REQUEST,
      );
      expect(selection, reason).toBeNull();
    }
  });

  test('a structured vendor failure in between is never an eligible no-fresh notice', () => {
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({
          cycleId: 'c002-aaaaaaaa',
          completion: { kind: 'blocked', reason: 'reviewer rate limit exceeded' },
          vendorFailure: {
            source: 'vendor',
            category: 'vendor-rate-limited',
            codes: ['rate_limited'],
          },
        }),
        cycleRecord({
          cycleId: 'c003-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
      ],
      REQUEST,
    );
    expect(selection).toBeNull();
  });

  test('an intervening genuine blocker before a NEWER terminal resets the anchor to that terminal', () => {
    // A fresh review after the blocker is the evidence that resolves it; the
    // newer same-identity terminal becomes the selection, not an old anchor.
    const blocker = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
    });
    expect(
      findReusableCycle(
        [cycleRecord(), blocker, cycleRecord({ cycleId: 'c003-aaaaaaaa' })],
        REQUEST,
      ),
    ).toMatchObject({ basis: 'exact-terminal', cycle: { cycleId: 'c003-aaaaaaaa' } });
    // …and a later no-fresh tail resolves against that newer terminal only.
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          blocker,
          cycleRecord({ cycleId: 'c003-aaaaaaaa' }),
          cycleRecord({
            cycleId: 'c004-aaaaaaaa',
            completion: { kind: 'blocked', reason: NO_FRESH_REASON },
          }),
        ],
        REQUEST,
      ),
    ).toMatchObject({
      basis: 'no-fresh-tail',
      cycle: { cycleId: 'c003-aaaaaaaa' },
      resolvesCycleId: 'c004-aaaaaaaa',
    });
  });

  test('consecutive affirmative no-fresh tails stay resolvable and name the latest', () => {
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({
          cycleId: 'c002-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
        cycleRecord({
          cycleId: 'c003-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
      ],
      REQUEST,
    );
    expect(selection).toMatchObject({
      basis: 'no-fresh-tail',
      cycle: { cycleId: 'c001-aaaaaaaa' },
      resolvesCycleId: 'c003-aaaaaaaa',
    });
  });

  test('a no-fresh-shaped reason that deviates from the recorded verdict wording refuses', () => {
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            completion: { kind: 'blocked', reason: 'no fresh review' },
          }),
        ],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('a terminal cycle at a DIFFERENT head refuses this identity (readiness would anchor on it)', () => {
    // A newer terminal at another head reviewed different content, so the
    // readiness anchor settles on it and reports stale-review-identity at
    // this tree. Reuse must refuse and let a fresh cycle run instead of
    // returning exact-terminal evidence the anchor will never accept.
    // (Findings from ANY cycle still block readiness through
    // open-blocking-findings; this refusal is about the reuse selection.)
    expect(
      findReusableCycle(
        [cycleRecord(), cycleRecord({ cycleId: 'c002-aaaaaaaa', head: 'newer-head' })],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('an earlier no-fresh tail that a newer same-identity terminal supersedes selects exact-terminal', () => {
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({
          cycleId: 'c002-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
        cycleRecord({ cycleId: 'c003-aaaaaaaa' }),
      ],
      REQUEST,
    );
    expect(selection).toMatchObject({
      basis: 'exact-terminal',
      cycle: { cycleId: 'c003-aaaaaaaa' },
    });
  });
  test('a later AGENT terminal does not disturb the CodeRabbit reuse pair (70601 tail rule intact)', () => {
    // A(CodeRabbit terminal) -> B(agent terminal) -> C(CodeRabbit affirmative
    // no-fresh): the selector's identity includes the reviewer, so B is neither
    // proof nor blocker for this request and the CodeRabbit pair stays A -> C.
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({ cycleId: 'c002-aaaaaaaa', reviewer: 'agent:reviewer' }),
        cycleRecord({
          cycleId: 'c003-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
      ],
      REQUEST,
    );
    expect(selection).toMatchObject({
      basis: 'no-fresh-tail',
      cycle: { cycleId: 'c001-aaaaaaaa' },
      resolvesCycleId: 'c003-aaaaaaaa',
    });
  });

  test('a later different-identity terminal refuses reuse (readiness would anchor on it)', () => {
    // c001 is an exact-terminal candidate, but c002 is a newer terminal full
    // cycle at a different head: readiness anchors on c002 and reports
    // stale-review-identity, so reuse must refuse and let a fresh cycle run.
    expect(
      findReusableCycle(
        [cycleRecord(), cycleRecord({ cycleId: 'c002-aaaaaaaa', head: 'd'.repeat(40) })],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('a later unconfigured terminal at a different identity does not refuse reuse', () => {
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            reviewer: 'other',
            head: 'd'.repeat(40),
            completion: { kind: 'terminal' },
          }),
        ],
        REQUEST,
      ),
    ).toMatchObject({ basis: 'exact-terminal' });
  });

  test('debtValid: only a later agent terminal at a differing identity refuses reuse', () => {
    const debt = { ...REQUEST, debtValid: true };
    expect(
      findReusableCycle(
        [cycleRecord(), cycleRecord({ cycleId: 'c002-aaaaaaaa', head: 'd'.repeat(40) })],
        debt,
      ),
    ).toMatchObject({ basis: 'exact-terminal' });
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            reviewer: 'agent:reviewer',
            head: 'd'.repeat(40),
          }),
        ],
        debt,
      ),
    ).toBeNull();
  });
});
